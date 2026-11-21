alter table ssma_epi.regions add column individual boolean not null default false,
 add constraint individual_estoque_do_responsavel check (not individual or (id=technician_id and id=owner_id and distribution_unit is null));

-- O responsável cadastrado pelo Master determina o estoque. Os vínculos antigos
-- de projeto continuam atendendo cadastros sem um técnico identificado.
create or replace function ssma_epi.employee_unit(e public.ssma_records) returns uuid
language sql stable security definer set search_path='' as $$
 select case when nullif(trim(e.unit),'') is null then null
   when nullif(e.details->>'technicianId','') is not null then
     (select coalesce(t.stock_unit,t.user_id) from public.ssma_profiles t where not t.is_master and t.user_id::text=e.details->>'technicianId' and t.active and e.employee_state=any(t.coverage))
   else coalesce((select region_id from ssma_epi.project_units where project_key=lower(trim(e.unit))),
     (select coalesce(stock_unit,user_id) from public.ssma_profiles where user_id=e.owner_id and active and not is_master)) end
$$;

create or replace function ssma_epi.manage(action text,p jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare k text; project text:=lower(trim(p->>'project')); dest uuid; actor public.ssma_profiles; responsible uuid;
begin
 if action in ('stock_technicians','material','allocate','edit_material') then
   if not ssma_epi.allowed('epi.estoque') then raise exception 'Sem permissão de estoque.'; end if;
   select * into strict actor from public.ssma_profiles where user_id=auth.uid() and active for share;
   if action='stock_technicians' then
     if not actor.is_master then raise exception 'Acesso exclusivo do Master.'; end if;
     return (select coalesce(jsonb_agg(jsonb_build_object('id',t.user_id,'name',t.display_name) order by t.display_name,t.user_id),'[]') from public.ssma_profiles t
       where t.active and not t.is_master and 'epi.estoque'=any(t.permissions));
   end if;
   if action='edit_material' then
     select m.region_id into dest from ssma_epi.materials m where m.id=(p->>'material_id')::uuid and m.archived_at is null for update;
     if not found then raise exception 'Material indisponível.'; end if;
   end if;
   if dest is null then
     responsible:=nullif(p->>'technician_id','')::uuid;
     if actor.is_master then
       if responsible is null then
         select min(t.user_id::text)::uuid into responsible from public.ssma_profiles t where t.active and not t.is_master and 'epi.estoque'=any(t.permissions) having count(*)=1;
       end if;
       select coalesce(t.stock_unit,t.user_id) into dest from public.ssma_profiles t where t.user_id=responsible and t.active and not t.is_master and 'epi.estoque'=any(t.permissions) for share;
     else
       if responsible is not null and responsible<>actor.user_id then raise exception 'O material deve usar o estoque do seu cadastro.'; end if;
       responsible:=actor.user_id;
       dest:=coalesce(actor.stock_unit,responsible);
     end if;
     if dest is null then raise exception 'Selecione um técnico ativo com permissão de estoque no Painel Master.'; end if;
     if dest=responsible then
       insert into ssma_epi.regions(id,owner_id,technician_id,name,individual)
       select t.user_id,t.user_id,t.user_id,'Estoque de '||t.display_name,true from public.ssma_profiles t where t.user_id=responsible
       on conflict(id) do nothing;
       if not exists(select 1 from ssma_epi.regions where id=dest and individual) then raise exception 'Identificador de estoque indisponível.'; end if;
     end if;
   end if;
   if nullif(p->>'region_id','')::uuid is not null and (p->>'region_id')::uuid<>dest then raise exception 'O estoque informado difere do cadastro. Reabra o material.'; end if;
   p:=jsonb_set(p,'{region_id}',to_jsonb(dest));
 end if;
 if action='history' then
   if not ssma_epi.allowed('epi.historico') then raise exception 'Sem acesso ao histórico.'; end if;
   if nullif(p->>'start','')::date is null or nullif(p->>'end','')::date is null or (p->>'start')::date>(p->>'end')::date then raise exception 'Informe um período válido.'; end if;
   return (select coalesce(jsonb_agg(to_jsonb(h) order by h.created_at desc,h.id),'[]') from (
     select v.id,v.created_at,v.kind,v.qty,v.material_label,r.name as unit,q.project,q.employee,
       case when ssma_epi.allowed('epi.financeiro') then v.price*v.qty end as total
     from ssma_epi.movements v left join ssma_epi.regions r on r.id=v.region_id left join ssma_epi.requests q on q.id=v.request_id
     where ssma_epi.can_use_stock(r) and (q.id is null or ssma_epi.request_in_area(q.employee_id,q.state))
       and v.created_at>=((p->>'start')::date::timestamp at time zone 'America/Sao_Paulo')
       and v.created_at<(((p->>'end')::date+1)::timestamp at time zone 'America/Sao_Paulo')
   ) h);
 end if;
 if action in ('edit_material','delete_material') then return ssma_epi.maintain_material(action,p); end if;
 if action='project_unit' then
   if not exists(select 1 from public.ssma_profiles where user_id=auth.uid() and is_master and active) then raise exception 'Somente o Master pode definir a unidade do projeto.'; end if;
   select id into dest from ssma_epi.regions where id=(p->>'region_id')::uuid and distribution_unit is not null;
   if dest is null or not exists(select 1 from public.ssma_records where module='colaboradores' and lower(trim(unit))=project) then raise exception 'Selecione um projeto e uma unidade de distribuição.'; end if;
   insert into ssma_epi.project_units(project_key,region_id) values(project,dest)
   on conflict(project_key) do update set region_id=excluded.region_id;
   return jsonb_build_object('ok',true);
 end if;
 k:=case when action in('entry','material','allocate','glove_date') then 'estoque' when action in('deliver','cancel','progress') then 'solicitacoes'
 when action='rule' then 'compras' when action in('asset','test') then 'ensaios' end;
 if k is null or not ssma_epi.allowed('epi.'||k) then raise exception 'Sem permissão para esta operação.'; end if;
 if action in ('progress','deliver','cancel','asset','test') and not exists(select 1 from ssma_epi.requests q where q.id=case when action='test' then (select a.request_id from ssma_epi.assets a where a.id=(p->>'asset_id')::uuid) else (p->>'request_id')::uuid end and ssma_epi.request_in_area(q.employee_id,q.state)) then raise exception 'Pedido fora da área de atendimento.'; end if;
 if action='rule' then
   perform 1 from ssma_epi.materials where id=(p->>'material_id')::uuid and archived_at is null for share;
   if not found then raise exception 'Material indisponível.'; end if;
 end if;
 return ssma_epi.manage_owned(action,p);
end $$;
create or replace function ssma_epi.can_use_stock(r ssma_epi.regions) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.ssma_profiles t where t.user_id=auth.uid() and t.active and (t.is_master or t.stock_unit=r.id or (r.individual and r.id=t.user_id)))
$$;
create or replace function ssma_epi.record_area_for(x public.ssma_records,actor uuid) returns boolean language plpgsql stable security definer set search_path='' as $$
declare p public.ssma_profiles; e public.ssma_records;
begin
 select * into p from public.ssma_profiles where user_id=actor and active;
 if p.user_id is null then return false; end if;
 if p.is_master then return true; end if;
 if x.module='colaboradores' then return coalesce(p.stock_unit,p.user_id)=ssma_epi.employee_unit(x) and p.coverage && ssma_epi.employee_states(x.id,x.employee_state,x.unit); end if;
 if x.employee_id is not null then select * into e from public.ssma_records where id=x.employee_id and module='colaboradores';
 elsif trim(x.person)<>'' then
 begin
 select * into strict e from public.ssma_records where owner_id=x.owner_id and module='colaboradores' and lower(trim(title))=lower(trim(x.person));
 exception when no_data_found then
 select * into strict e from public.ssma_records where module='colaboradores' and lower(trim(title))=lower(trim(x.person));
 end;
 else return x.owner_id=p.user_id; end if;
 return e.id is not null and coalesce(p.stock_unit,p.user_id)=ssma_epi.employee_unit(e) and p.coverage && ssma_epi.employee_states(e.id,e.employee_state,e.unit);
exception when no_data_found then return false; when too_many_rows then return false;
end $$;
create or replace function ssma_epi.request_in_area_for(employee uuid, uf text, actor uuid) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.ssma_profiles p where p.user_id=actor and p.active and (p.is_master or
 (uf=any(p.coverage) and exists(select 1 from public.ssma_records e where e.id=employee and e.module='colaboradores' and coalesce(p.stock_unit,p.user_id)=ssma_epi.employee_unit(e) and p.coverage && ssma_epi.employee_states(e.id,e.employee_state,e.unit)))))
$$;
create or replace function ssma_epi.manage_owned(action text, p jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare
 actor uuid := auth.uid(); reg ssma_epi.regions; mat ssma_epi.materials; req ssma_epi.requests;
 line ssma_epi.lines; asset ssma_epi.assets; rec public.ssma_records; tech uuid; secret text;
 amount int; cost numeric(14,2); target text; item_id uuid; region_id_arg uuid := nullif(p->>'region_id','')::uuid;
begin
 if not exists(select 1 from public.ssma_profiles where user_id=actor) then raise exception 'Acesso restrito.'; end if;
 if action in ('material','allocate') then
   select r.* into reg from ssma_epi.regions r where r.id=region_id_arg and (r.distribution_unit is not null or r.individual) and ssma_epi.can_use_stock(r);
   if reg.id is null then raise exception 'Selecione uma unidade de distribuição autorizada.'; end if;
 end if;
 case action
 when 'material' then
 amount:=coalesce(nullif(p->>'qty','')::integer,0); cost:=coalesce(nullif(p->>'price','')::numeric,0);
 insert into ssma_epi.materials(id,owner_id,region_id,stock_center,name,ca,no_ca,price,qty,minimum,expiry,size,color,insulating_glove,glove_start,glove_left_number,glove_right_number)
 values((p->>'id')::uuid,actor,reg.id,'SSMA',trim(p->>'name'),trim(coalesce(p->>'ca','')),coalesce((p->>'no_ca')::boolean,false),
 cost,amount,coalesce(nullif(p->>'minimum','')::int,0),nullif(p->>'expiry','')::date,trim(coalesce(p->>'size','')),trim(coalesce(p->>'color','')),coalesce((p->>'insulating_glove')::boolean,false) or ssma_epi.is_glove(p->>'name',p->>'ca'),nullif(p->>'glove_start','')::date,
 nullif(trim(p->>'glove_left_number'),''),nullif(trim(p->>'glove_right_number'),''))
 returning * into mat;
 if amount>0 then insert into ssma_epi.movements(owner_id,region_id,material_id,kind,qty,price) values(actor,reg.id,mat.id,'Entrada',amount,cost); end if;
 when 'glove_date' then
 update ssma_epi.materials m set glove_start=(p->>'glove_start')::date
 where m.id=(p->>'material_id')::uuid and m.insulating_glove and m.glove_start is not distinct from nullif(p->>'previous','')::date and exists(
 select 1 from public.ssma_profiles t left join ssma_epi.regions r on r.id=m.region_id where t.user_id=actor and t.active and
 (t.is_master or ssma_epi.can_use_stock(r)));
 if not found then raise exception 'Lote indisponível ou já atualizado.'; end if;
 when 'entry','allocate','rule' then
 select * into strict mat from ssma_epi.materials where id=(p->>'material_id')::uuid and ((region_id is null and (exists(select 1 from public.ssma_profiles where user_id=actor and is_master and active))) or region_id in(select r.id from ssma_epi.regions r where ssma_epi.can_use_stock(r))) for update;
 if action='entry' then
 amount:=(p->>'qty')::int; cost:=coalesce(nullif(p->>'price','')::numeric,mat.price);
 insert into ssma_epi.movements(id,owner_id,region_id,material_id,kind,qty,price) values((p->>'id')::uuid,mat.owner_id,mat.region_id,mat.id,'Entrada',amount,cost);
 update ssma_epi.materials set price=round((price*qty+cost*amount)/(qty+amount),2),qty=qty+amount where id=mat.id;
 elsif action='allocate' then
 if mat.region_id is not null or reg.id is null  then raise exception 'Selecione um material sem regional e uma regional válida.'; end if;
 update ssma_epi.materials set region_id=reg.id where id=mat.id;
 update ssma_epi.movements set region_id=reg.id where material_id=mat.id and region_id is null;
 else
 insert into ssma_epi.rules values(mat.id,lower(trim(p->>'job')),(p->>'days')::int,(p->>'qty')::int)
 on conflict(material_id,job) do update set days=excluded.days,qty=excluded.qty;
 end if;
 when 'progress' then
 select q.* into strict req from ssma_epi.requests q join ssma_epi.regions r on r.id=q.region_id
 where q.id=(p->>'request_id')::uuid and ssma_epi.can_use_stock(r) for update of q;
 if req.status<>'Solicitado' then raise exception 'Solicitação já encerrada.'; end if;
 target:=p->>'stage';
 if target is null or target not in ('Pedido recebido','Pedido separado','Aguardando aprovação do projeto','Pronto para retirada na base','Enviado pelos Correios') then raise exception 'Etapa inválida.'; end if;
 if req.stage is distinct from p->>'previous_stage' or req.postal is distinct from coalesce(p->>'previous_postal','') then raise exception 'O pedido mudou. Atualize a lista antes de continuar.'; end if;
 if length(trim(coalesce(p->>'postal','')))>64 then raise exception 'Número de rastreamento muito longo.'; end if;
 if req.stage<>target or req.postal<>upper(trim(coalesce(p->>'postal',''))) then
 update ssma_epi.requests set stage=target, postal=upper(trim(coalesce(p->>'postal',''))),
 events=events||jsonb_build_array(jsonb_build_object('date',now(),'stage',target))
 where id=req.id;
 end if;
 when 'deliver','cancel' then
 select q.* into strict req from ssma_epi.requests q join ssma_epi.regions r on r.id=q.region_id
 where q.id=(p->>'request_id')::uuid and ssma_epi.can_use_stock(r) for update of q;
 if req.status<>'Solicitado' then raise exception 'Solicitação já encerrada.'; end if;
 target:='Projeto';
 if action='deliver' and (target is null or target not in ('Projeto','SSMA')) then raise exception 'Confirme o destino do custo.'; end if;
 for line in select * from ssma_epi.lines where request_id=req.id order by material_id loop
 select * into strict mat from ssma_epi.materials where id=line.material_id for update;
 if action='deliver' and (mat.expiry < (now() at time zone 'America/Sao_Paulo')::date or (mat.insulating_glove and (mat.glove_start is null or mat.glove_start > (now() at time zone 'America/Sao_Paulo')::date))) then raise exception 'Material vencido. Cancele a reserva e selecione outro material.'; end if;
 update ssma_epi.materials set reserved=reserved-line.qty,qty=qty-case when action='deliver' then line.qty else 0 end where id=mat.id;
 if action='deliver' then
 update ssma_epi.lines set price=mat.price where request_id=req.id and material_id=mat.id;
 insert into ssma_epi.movements(owner_id,region_id,material_id,request_id,kind,qty,price)
 values(req.owner_id,req.region_id,mat.id,req.id,'Saída',line.qty,mat.price);
 end if;
 end loop;
 update ssma_epi.requests set status=case when action='deliver' then 'Entregue' else 'Cancelado' end,
 closed_at=now(),confirmed_by=actor,confirmed_name=(select display_name from public.ssma_profiles where user_id=actor),
 destination=case when action='deliver' then target end where id=req.id;
 when 'asset' then
 select q.* into strict req from ssma_epi.requests q join ssma_epi.regions r on r.id=q.region_id
 where q.id=(p->>'request_id')::uuid and ssma_epi.can_use_stock(r) and q.status='Entregue' for update of q;
 item_id:=(p->>'material_id')::uuid;
 select * into strict line from ssma_epi.lines where request_id=req.id and material_id=item_id;
 if (select count(*) from ssma_epi.assets where request_id=req.id and material_id=item_id)>=line.qty then raise exception 'Todas as unidades da entrega já têm série.'; end if;
 insert into ssma_epi.assets(owner_id,request_id,material_id,serial,period_days,due) values(req.owner_id,req.id,item_id,trim(p->>'serial'),(p->>'days')::int,(p->>'due')::date);
 when 'test' then
 select a.* into strict asset from ssma_epi.assets a join ssma_epi.requests q on q.id=a.request_id join ssma_epi.regions r on r.id=q.region_id
 where a.id=(p->>'asset_id')::uuid and ssma_epi.can_use_stock(r) for update of a;
 target:=p->>'status';
 if not coalesce((asset.status='Em uso' and target='Em trânsito') or (asset.status='Em trânsito' and target='No laboratório')
 or (asset.status='No laboratório' and target in ('Em retorno','Reprovado')) or (asset.status='Em retorno' and target='Em uso'),false)
 then raise exception 'Transição de ensaio inválida.'; end if;
 if target='Em trânsito' and nullif(trim(p->>'lab'),'') is null then raise exception 'Informe o laboratório.'; end if;
 if target in ('Em retorno','Reprovado') and nullif(trim(p->>'report'),'') is null then raise exception 'Informe o número ou resultado do laudo.'; end if;
 update ssma_epi.assets set status=target,lab=case when target='Em trânsito' then trim(p->>'lab') else lab end,
 due=case when target='Em retorno' then (now() at time zone 'America/Sao_Paulo')::date+period_days else due end where id=asset.id returning * into asset;
 insert into ssma_epi.tests(asset_id,status,lab,report) values(asset.id,target,asset.lab,trim(coalesce(p->>'report','')));
 else raise exception 'Operação desconhecida.';
 end case;
 return jsonb_build_object('ok',true);
exception when no_data_found then raise exception 'Registro indisponível para este usuário.';
end $$;
create or replace function ssma_epi.maintain_material(action text,p jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare
 m ssma_epi.materials; dest uuid; new_qty int; new_price numeric(14,2); moved boolean;
 add_qty int; remove_qty int; is_glove boolean;
begin
 if action not in ('edit_material','delete_material') or not ssma_epi.allowed('epi.estoque') then
   raise exception 'Sem permissão para alterar o estoque.';
 end if;
 select s.* into m from ssma_epi.materials s
 where s.id=(p->>'material_id')::uuid and s.archived_at is null and
 ((s.region_id is null and exists(select 1 from public.ssma_profiles t where t.user_id=auth.uid() and t.active and t.is_master))
  or exists(select 1 from ssma_epi.regions r where r.id=s.region_id and ssma_epi.can_use_stock(r)))
 for update;
 if not found then raise exception 'Material indisponível para este usuário.'; end if;
 if m.revision is distinct from (p->>'revision')::bigint then
   raise exception 'O material mudou. Atualize o estoque e abra a ação novamente.';
 end if;
 if action='delete_material' then
   if m.reserved>0 then raise exception 'Conclua ou cancele as reservas antes de excluir este material.'; end if;
   if m.qty>0 then
     insert into ssma_epi.movements(owner_id,region_id,material_id,kind,qty,price)
     values(m.owner_id,m.region_id,m.id,'Ajuste de saída',m.qty,m.price);
   end if;
   update ssma_epi.materials set qty=0, archived_at=now() where id=m.id;
 else
   dest:=(p->>'region_id')::uuid;
   if not exists(select 1 from ssma_epi.regions r where r.id=dest and (r.distribution_unit is not null or r.individual) and ssma_epi.can_use_stock(r)) then
     raise exception 'Selecione uma unidade de distribuição autorizada.';
   end if;
   moved := m.region_id is distinct from dest;
   new_qty:=(p->>'qty')::int;
   new_price:=(p->>'price')::numeric;
   if new_qty<m.reserved or (m.reserved>0 and (moved or
      (m.name,m.ca,m.size,m.color) is distinct from (trim(p->>'name'),trim(coalesce(p->>'ca','')),trim(p->>'size'),trim(p->>'color')))) then
      raise exception 'A alteração é incompatível com as reservas deste material.';
   end if;
   remove_qty:=case when moved then m.qty else greatest(m.qty-new_qty,0) end;
   add_qty:=case when moved then new_qty else greatest(new_qty-m.qty,0) end;
   if remove_qty>0 then
     insert into ssma_epi.movements(owner_id,region_id,material_id,kind,qty,price)
     values(m.owner_id,m.region_id,m.id,'Ajuste de saída',remove_qty,m.price);
   end if;
   is_glove:=coalesce((p->>'insulating_glove')::boolean,false) or ssma_epi.is_glove(p->>'name',p->>'ca');
   update ssma_epi.materials set name=trim(p->>'name'), ca=trim(coalesce(p->>'ca','')), no_ca=(p->>'no_ca')::boolean,
     minimum=(p->>'minimum')::int, qty=new_qty, price=new_price, size=trim(p->>'size'), color=trim(p->>'color'),
     region_id=dest, expiry=nullif(p->>'expiry','')::date, insulating_glove=is_glove,
     glove_left_number=case when is_glove then case when p ? 'glove_left_number' then nullif(trim(p->>'glove_left_number'),'') else m.glove_left_number end end,
     glove_right_number=case when is_glove then case when p ? 'glove_right_number' then nullif(trim(p->>'glove_right_number'),'') else m.glove_right_number end end,
     glove_start=case when is_glove then nullif(p->>'glove_start','')::date end
   where id=m.id;
   if add_qty>0 then
     insert into ssma_epi.movements(owner_id,region_id,material_id,kind,qty,price)
     values(m.owner_id,dest,m.id,'Ajuste de entrada',add_qty,new_price);
   end if;
   if p ? 'ca_expiry' then perform ssma_epi.change_ca_expiry(p); end if;
 end if;
 return jsonb_build_object('ok',true);
end $$;
create or replace function ssma_epi.portal(action text, p jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare
 emp public.ssma_records; a ssma_epi.assignments; r ssma_epi.regions; tech text;
 mat ssma_epi.materials; item record; result jsonb; req_id uuid; inserted uuid;
begin
 if action='track' then
 select jsonb_build_object('stage',case when q.status='Solicitado' then q.stage else q.status end,'postal',q.postal,
 'events',jsonb_build_array(jsonb_build_object('stage','Pedido recebido','date',q.created_at)) || q.events ||
 case when q.closed_at is null then '[]'::jsonb else jsonb_build_array(jsonb_build_object('stage',q.status,'date',q.closed_at)) end)
 into result from ssma_epi.requests q where q.tracking_code=upper(trim(p->>'code'));
 if result is null then raise exception 'Pedido não encontrado. Confira o código de rastreio.'; end if;
 return result;
 end if;
 if action='track_name' then
   if length(trim(p->>'name'))<2 or nullif(trim(p->>'name'),'') is null then raise exception 'Digite o nome completo.'; end if;
   return (select coalesce(jsonb_agg(to_jsonb(z) order by z.name,z.project,z.id),'[]') from (
     select e.id,e.title name,e.unit project from public.ssma_records e where e.module='colaboradores' and lower(trim(e.title))=lower(trim(p->>'name'))
     union all select distinct on(q.employee_id) q.employee_id,q.employee,q.project from ssma_epi.requests q
       where lower(trim(q.employee))=lower(trim(p->>'name')) and not exists(select 1 from public.ssma_records e where e.id=q.employee_id)
   ) z);
 end if;
 if action='track_employee' then
   return (select coalesce(jsonb_agg(jsonb_build_object('date',q.created_at,'project',q.project,'status',case when q.status='Solicitado' then q.stage else q.status end,'postal',q.postal)
     order by q.created_at desc,q.id),'[]') from ssma_epi.requests q where q.employee_id=(p->>'employee_id')::uuid and (lower(trim(q.employee))=lower(trim(p->>'name')) or exists(select 1 from public.ssma_records e where e.id=q.employee_id and lower(trim(e.title))=lower(trim(p->>'name')))));
 end if;
 if action='names' then
 select coalesce(jsonb_agg(jsonb_build_object('id',e.id,'name',e.title,'project',e.unit) order by e.title,e.id),'[]') into result
 from public.ssma_records e where e.module='colaboradores' and e.status='Ativo'
 ;
 return result;
 end if;
 select * into emp from public.ssma_records e where e.id=(p->>'employee_id')::uuid and e.module='colaboradores' and e.status='Ativo' for share;
 if emp.id is null then raise exception 'Colaborador indisponível.'; end if;
 if action='states' then return (select coalesce(jsonb_agg(v.state order by v.state),'[]') from ssma_epi.assignments v where v.employee_id=emp.id); end if;
 if action='submit' then
   perform 1 from public.ssma_profiles t where t.user_id::text=coalesce(nullif(emp.details->>'technicianId',''),emp.owner_id::text) for share;
 end if;
 perform 1 from ssma_epi.project_units where project_key=lower(trim(emp.unit)) for share;
 select * into a from ssma_epi.assignments where employee_id=emp.id and
 (state=coalesce(nullif(p->>'state',''),emp.employee_state) or (emp.employee_state is null and not (p ? 'state') and 1=(select count(*) from ssma_epi.assignments where employee_id=emp.id)));
 if a.region_id is null and action<>'context' then raise exception 'Vínculo com a regional não encontrado.'; end if;
 select * into r from ssma_epi.regions where id=a.region_id and (distribution_unit is not null or (individual and id=ssma_epi.employee_unit(emp)) or owner_id=emp.owner_id) for share;
 select display_name into tech from public.ssma_profiles t where t.active and coalesce(t.stock_unit,t.user_id)=r.id and a.state=any(t.coverage)
 order by (t.user_id::text=emp.details->>'technicianId') desc nulls last,t.display_name,t.user_id limit 1;
 select coalesce((select display_name from public.ssma_profiles where user_id::text=emp.details->>'technicianId' and active),tech,'A definir') into tech;
 if action='context' then
 return jsonb_build_object('project',emp.unit,'job',coalesce(a.job,emp.details->>'extra'),'technician',tech,
 'management',emp.details->>'management','coordinator',emp.details->>'coordinator','registration',nullif(trim(emp.details->>'registration'),''),
 'cpf_masked',case when nullif(trim(emp.details->>'registration'),'') is null and length(regexp_replace(emp.details->>'cpf','[^0-9]','','g'))=11 then '***.***.***-'||right(regexp_replace(emp.details->>'cpf','[^0-9]','','g'),2) end,
 'area',coalesce(nullif(emp.details->>'region',''),(select key from jsonb_each(ssma_epi.service_areas()) where value ? coalesce(emp.employee_state,a.state))),
 'materials',(select coalesce(jsonb_agg(jsonb_build_object('id',m.id,'name',m.name,'ca',m.ca,'size',m.size,'color',m.color,'available',m.qty-m.reserved) order by m.name,m.size),'[]')
 from ssma_epi.materials m where m.region_id=r.id and m.archived_at is null and (not m.insulating_glove or m.glove_start <= (now() at time zone 'America/Sao_Paulo')::date) and m.qty>m.reserved and (m.expiry is null or m.expiry>=(now() at time zone 'America/Sao_Paulo')::date)),
 'history',(select coalesce(jsonb_agg(jsonb_build_object('date',q.created_at,'closed_at',q.closed_at,'status',case when q.status='Solicitado' then q.stage else q.status end,'state',q.state,'project',q.project,
 'items',(select jsonb_agg(jsonb_build_object('name',l.name,'size',l.size,'color',l.color,'qty',l.qty) order by l.name) from ssma_epi.lines l where l.request_id=q.id)) order by q.created_at desc),'[]')
 from ssma_epi.requests q where q.employee_id=emp.id));
 end if;
 if action<>'submit' or action is null then raise exception 'Operação desconhecida.'; end if;
 if jsonb_typeof(p->'items') is distinct from 'array' or jsonb_array_length(p->'items') not between 1 and 100 then raise exception 'Selecione de 1 a 100 materiais.'; end if;
 req_id:=(p->>'id')::uuid;
 insert into ssma_epi.requests(id,owner_id,employee_id,region_id,employee,state,project,job,technician,center,contract)
 values(req_id,emp.owner_id,emp.id,r.id,emp.title,a.state,a.project,a.job,tech,a.center,a.contract)
 on conflict(id) do nothing returning id into inserted;
 if inserted is null then
 if exists(select 1 from ssma_epi.requests q where q.id=req_id and q.employee_id=emp.id and q.region_id=r.id)
 and (select jsonb_agg(jsonb_build_object('id',l.material_id,'qty',l.qty) order by l.material_id) from ssma_epi.lines l where l.request_id=req_id)
 = (select jsonb_agg(v order by v->>'id') from jsonb_array_elements(p->'items') v) then return (select to_jsonb(tracking_code) from ssma_epi.requests where id=req_id); end if;
 raise exception 'Identificador de solicitação já utilizado.';
 end if;
 for item in select * from jsonb_to_recordset(p->'items') as i(id uuid,qty integer) order by id loop
 select * into mat from ssma_epi.materials where id=item.id and region_id=r.id and archived_at is null and (not insulating_glove or glove_start <= (now() at time zone 'America/Sao_Paulo')::date) for update;
 if mat.id is null or item.qty is null or item.qty<=0 or item.qty>mat.qty-mat.reserved
 or mat.expiry<(now() at time zone 'America/Sao_Paulo')::date then raise exception 'Saldo insuficiente ou material indisponível. Atualize os materiais.'; end if;
 insert into ssma_epi.lines(request_id,material_id,name,ca,size,color,qty) values(req_id,mat.id,mat.name,mat.ca,mat.size,mat.color,item.qty);
 update ssma_epi.materials set reserved=reserved+item.qty where id=mat.id;
 end loop;
 return (select to_jsonb(tracking_code) from ssma_epi.requests where id=req_id);
end $$;
create or replace function ssma_epi.glove_summary(technician uuid) returns jsonb language sql stable security definer set search_path='' as $$
 select coalesce(jsonb_agg(to_jsonb(x) order by x.unit),'[]') from (
 select coalesce(r.distribution_unit,r.name) unit, case r.state when 'DF' then 'Centro-Oeste' when 'RJ' then 'Sudeste' else coalesce(r.distribution_unit,r.name) end region, r.state,
 coalesce(sum(m.qty),0) qty, coalesce(sum(m.qty*m.price),0) cost,
 coalesce(sum(case when m.glove_start <= (now() at time zone 'America/Sao_Paulo')::date and m.expiry >= (now() at time zone 'America/Sao_Paulo')::date then m.qty-m.reserved else 0 end),0) available
 from ssma_epi.regions r left join ssma_epi.materials m on m.region_id=r.id and m.insulating_glove
 where (r.distribution_unit is not null or r.individual) and ssma_epi.allowed('epi.estoque') and ssma_epi.can_use_stock(r) and (technician is null or exists(select 1 from public.ssma_profiles t where t.user_id=technician and (t.is_master or (t.stock_unit=r.id or (r.individual and r.id=t.user_id)))))
 group by r.id) x
$$;
create or replace function ssma_epi.master(action text,p jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb; target public.ssma_profiles;
begin
 if not exists(select 1 from public.ssma_profiles where user_id=auth.uid() and is_master and active) then raise exception 'Acesso exclusivo do Master.'; end if;
 if action='authorize_creation' then return to_jsonb(auth.uid()); end if;
 if action in ('block_technician','unblock_technician','remove_technician') then
   select * into target from public.ssma_profiles
   where user_id=(p->>'technician')::uuid and user_id<>auth.uid() and not is_master and removed_at is null
   for update;
   if not found then raise exception 'Técnico indisponível. Atualize a lista.'; end if;
   if target.active is distinct from (p->>'previous_active')::boolean then
     raise exception 'O acesso mudou. Atualize a lista antes de continuar.';
   end if;
   if action='remove_technician' then
     -- An app-created login can be deleted when its profile has no dependent history.
     begin
       delete from auth.users where id=target.user_id and email=target.username||'@ssma.invalid'
         and raw_app_meta_data->'ssma_technician' is not null;
       if found then return 'true'::jsonb; end if;
     exception when foreign_key_violation then
       null;
     end;
     update public.ssma_profiles set active=false, removed_at=now(), permissions='{}', coverage='{}'
       where user_id=target.user_id;
     return jsonb_build_object('region_count',(select count(*) from ssma_epi.regions where technician_id=target.user_id));
   else
     update public.ssma_profiles set active=(action='unblock_technician') where user_id=target.user_id;
   end if;
   return 'true'::jsonb;
 end if;
 if action='edit_technician' then
 if p ? 'service_region' and not (p ? 'coverage') then raise exception 'Atualize a página para editar a área de atendimento.'; end if;
 if nullif(trim(p->>'name'),'') is null or length(trim(p->>'name'))>120 then raise exception 'Informe um nome de até 120 caracteres.'; end if;
 if nullif(p->>'stock_unit','') is not null and not exists(select 1 from ssma_epi.regions where id=(p->>'stock_unit')::uuid and distribution_unit is not null) then raise exception 'Unidade inválida.'; end if;
 update public.ssma_profiles set stock_unit=case when p ? 'stock_unit' then nullif(p->>'stock_unit','')::uuid else stock_unit end, display_name=trim(p->>'name'),active=(p->>'active')::boolean,
 coverage=case when p ? 'coverage' then array(select jsonb_array_elements_text(p->'coverage')) else coverage end
 where user_id=(p->>'technician')::uuid and not is_master and removed_at is null and display_name=p->>'previous_name' and active=(p->>'previous_active')::boolean
 and (not (p ? 'stock_unit') or stock_unit is not distinct from nullif(p->>'previous_unit','')::uuid) and (not (p ? 'coverage') or coverage=array(select jsonb_array_elements_text(p->'previous_coverage')));
 if not found then raise exception 'Cadastro alterado. Atualize a lista de técnicos.'; end if;
 return 'true'::jsonb;
 end if;
 if action='permissions' then
 update public.ssma_profiles set permissions=array(select distinct jsonb_array_elements_text(p->'permissions'))
 where user_id=(p->>'technician')::uuid and not is_master and removed_at is null and permissions=array(select jsonb_array_elements_text(p->'previous'));
 if not found then raise exception 'Permissões alteradas ou perfil indisponível. Atualize o painel.'; end if;
 return 'true'::jsonb;
 end if;
 if action<>'overview' then raise exception 'Operação inválida.'; end if;
 with assigned as (
 select distinct t.user_id tech,a.project,a.state from ssma_epi.assignments a join ssma_epi.regions r on r.id=a.region_id
 join public.ssma_profiles t on (t.stock_unit=r.id or (r.individual and r.id=t.user_id)) and t.active and a.state=any(t.coverage)
 union select distinct t.user_id,q.project,q.state from ssma_epi.requests q join ssma_epi.regions r on r.id=q.region_id join public.ssma_profiles t on (t.stock_unit=r.id or (r.individual and r.id=t.user_id)) and t.active and q.state=any(t.coverage)
 ), rows as (
 select x.module,x.status,x.event_date,x.due_date,jsonb_build_object('extra',x.details->>'extra') details,x.unit,
 array(select t.user_id from public.ssma_profiles t where (x.owner_id=t.user_id or x.module='colaboradores' or x.employee_id is not null)
 and (t.is_master or (case when x.module='epis' then 'epi.anteriores' else x.module end)=any(t.permissions)) and ssma_epi.record_area_for(x,t.user_id)) techs,
 case when x.module='colaboradores' then ssma_epi.employee_states(x.id,x.employee_state,x.unit)
 when x.employee_id is not null then (select ssma_epi.employee_states(e.id,e.employee_state,e.unit) from public.ssma_records e where e.id=x.employee_id)
 when exists(select 1 from assigned a where a.tech=x.owner_id and a.project=x.unit) then array(select distinct a.state from assigned a where a.tech=x.owner_id and a.project=x.unit)
 else ssma_epi.employee_states(null,null,x.unit) end states
 from public.ssma_records x
 union all select 'epis',case q.status when 'Entregue' then 'Concluído' when 'Cancelado' then 'Inativo' else 'Pendente' end,
 (q.created_at at time zone 'America/Sao_Paulo')::date,null,'{}'::jsonb,q.project,array(select t.user_id from public.ssma_profiles t where (t.is_master or (t.stock_unit=r.id or (r.individual and r.id=t.user_id))) and (t.is_master or 'epi.solicitacoes'=any(t.permissions)) and ssma_epi.request_in_area_for(q.employee_id,q.state,t.user_id)),array[q.state] from ssma_epi.requests q join ssma_epi.regions r on r.id=q.region_id
 ), projects as (
 select distinct who.tech, x.unit as project, coalesce(uf.state,'Sem UF informada') as state
 from rows x cross join lateral unnest(x.techs) who(tech) cross join lateral unnest(x.states) uf(state)
 join public.ssma_profiles t on t.user_id=who.tech
 where trim(x.unit)<>'' and (t.is_master or uf.state is null or uf.state=any(t.coverage))
 union select a.tech,a.project,a.state from assigned a join public.ssma_profiles t on t.user_id=a.tech
 where t.active and (t.is_master or a.state=any(t.coverage))
 )
 select jsonb_build_object('service_areas',ssma_epi.service_areas(),'people',(select jsonb_agg(jsonb_build_object('id',user_id,'name',display_name,'master',is_master,'stock_unit',stock_unit,'username',username,'coverage',coverage,'active',active,'permissions',permissions) order by display_name) from public.ssma_profiles where removed_at is null),
 'rows',coalesce((select jsonb_agg(to_jsonb(x)) from rows x),'[]'),'projects',coalesce((select jsonb_agg(to_jsonb(v) order by state,project) from projects v),'[]')) into result;
 return result || jsonb_build_object('units',(select jsonb_agg(jsonb_build_object('id',id,'name',distribution_unit) order by distribution_unit) from ssma_epi.regions where distribution_unit is not null),
 'routing',(select coalesce(jsonb_agg(to_jsonb(z) order by z.project),'[]') from (select min(trim(e.unit)) project,p.region_id from public.ssma_records e left join ssma_epi.project_units p on p.project_key=lower(trim(e.unit)) where e.module='colaboradores' and trim(e.unit)<>'' group by lower(trim(e.unit)),p.region_id) z));
end $$;
-- A primeira vinculação a uma unidade compartilha o saldo existente e as reservas.
-- As movimentações anteriores conservam sua origem para consulta no histórico.
create function ssma_epi.share_personal_stock() returns trigger language plpgsql security definer set search_path='' as $$
declare item ssma_epi.materials;
begin
 if new.display_name is distinct from old.display_name then
   update ssma_epi.regions set name='Estoque de '||new.display_name where id=new.user_id and individual;
 end if;
 if new.stock_unit is null or new.stock_unit is not distinct from old.stock_unit then return new; end if;
 if not exists(select 1 from ssma_epi.regions where id=new.user_id and individual) then return new; end if;
 update ssma_epi.requests set region_id=new.stock_unit where region_id=new.user_id and status='Solicitado';
 for item in select * from ssma_epi.materials where region_id=new.user_id and archived_at is null order by id for update loop
   if item.qty>0 then
     insert into ssma_epi.movements(owner_id,region_id,material_id,kind,qty,price) values
       (item.owner_id,item.region_id,item.id,'Ajuste de saída',item.qty,item.price),
       (item.owner_id,new.stock_unit,item.id,'Ajuste de entrada',item.qty,item.price);
   end if;
   update ssma_epi.materials set region_id=new.stock_unit where id=item.id;
 end loop;
 return new;
end $$;
revoke all on function ssma_epi.share_personal_stock() from public,anon,authenticated;
create trigger compartilhar_estoque_individual after update of stock_unit,display_name on public.ssma_profiles
for each row execute function ssma_epi.share_personal_stock();
create or replace view ssma_epi.assignments with (security_invoker = true) as
select e.id as employee_id, loc.uf as state, ssma_epi.employee_unit(e) as region_id, trim(e.unit) as project,
       coalesce(nullif(trim(e.details->>'extra'),''), l.job, '') as job,
       coalesce(l.center,'') as center, coalesce(l.contract,'') as contract
from public.ssma_records e

cross join lateral (select coalesce(e.employee_state, substring(upper(trim(e.unit)) from '/[[:space:]]*([A-Z]{2})$')) uf) loc
left join ssma_epi.legacy_assignments l on l.employee_id=e.id and l.state=loc.uf
where e.module='colaboradores' and ssma_epi.employee_unit(e) is not null and loc.uf=any(array['AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG','PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO'])
union all
select l.* from ssma_epi.legacy_assignments l join public.ssma_records e on e.id=l.employee_id
where exists(select 1 from ssma_epi.regions r where r.id=l.region_id and r.distribution_unit is null and not r.individual)
  and nullif(e.details->>'technicianId','') is null and ssma_epi.employee_unit(e) is null;
