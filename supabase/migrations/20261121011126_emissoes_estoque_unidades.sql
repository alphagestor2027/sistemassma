alter table public.ssma_profiles add column stock_unit uuid references ssma_epi.regions(id);
update public.ssma_profiles t set stock_unit=u.id from
 (select technician_id,min(id::text)::uuid id from ssma_epi.regions where distribution_unit is not null group by technician_id having count(*)=1) u
 where t.user_id=u.technician_id and not t.is_master;
alter table public.ssma_profiles drop constraint ssma_permissions_valid;
alter table public.ssma_profiles add constraint ssma_permissions_valid check
 (permissions <@ array['colaboradores','exames','prontuarios','afastamentos','ergonomia','riscos','acidentes','pt','inspecoes','licencas','residuos','emissoes','laia','esocial','treinamentos','terceiros','requisitos','bi','epi.estoque','epi.solicitacoes','epi.financeiro','epi.ficha','epi.ensaios','epi.compras','epi.historico','epi.anteriores' ]::text[] and array_position(permissions,null) is null) not valid;
update public.ssma_profiles set permissions=array_remove(permissions,'epi.regionais');
update public.ssma_profiles set permissions=array_append(permissions,'epi.historico') where 'epi.estoque'=any(permissions) or 'epi.financeiro'=any(permissions);
alter table public.ssma_profiles validate constraint ssma_permissions_valid;

create function ssma_epi.employee_unit(e public.ssma_records) returns uuid language sql stable security definer set search_path='' as $$
 select coalesce((select region_id from ssma_epi.project_units where project_key=lower(trim(e.unit))),
 (select stock_unit from public.ssma_profiles where user_id::text=coalesce(nullif(e.details->>'technicianId',''),e.owner_id::text) and active))
$$;
revoke all on function ssma_epi.employee_unit(public.ssma_records) from public,anon,authenticated;
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
where exists(select 1 from ssma_epi.regions r where r.id=l.region_id and r.distribution_unit is null)
  and ssma_epi.employee_unit(e) is null;
create or replace function ssma_epi.can_use_stock(r ssma_epi.regions) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.ssma_profiles t where t.user_id=auth.uid() and t.active and (t.is_master or t.stock_unit=r.id))
$$;
create or replace function ssma_epi.record_area_for(x public.ssma_records,actor uuid) returns boolean language plpgsql stable security definer set search_path='' as $$
declare p public.ssma_profiles; e public.ssma_records;
begin
 select * into p from public.ssma_profiles where user_id=actor and active;
 if p.user_id is null then return false; end if;
 if p.is_master then return true; end if;
 if x.module='colaboradores' then return p.stock_unit=ssma_epi.employee_unit(x) and p.coverage && ssma_epi.employee_states(x.id,x.employee_state,x.unit); end if;
 if x.employee_id is not null then select * into e from public.ssma_records where id=x.employee_id and module='colaboradores';
 elsif trim(x.person)<>'' then
 begin
 select * into strict e from public.ssma_records where owner_id=x.owner_id and module='colaboradores' and lower(trim(title))=lower(trim(x.person));
 exception when no_data_found then
 select * into strict e from public.ssma_records where module='colaboradores' and lower(trim(title))=lower(trim(x.person));
 end;
 else return x.owner_id=p.user_id; end if;
 return e.id is not null and p.stock_unit=ssma_epi.employee_unit(e) and p.coverage && ssma_epi.employee_states(e.id,e.employee_state,e.unit);
exception when no_data_found then return false; when too_many_rows then return false;
end $$;
create or replace function ssma_epi.request_in_area_for(employee uuid, uf text, actor uuid) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.ssma_profiles p where p.user_id=actor and p.active and (p.is_master or
 (uf=any(p.coverage) and exists(select 1 from public.ssma_records e where e.id=employee and e.module='colaboradores' and p.stock_unit=ssma_epi.employee_unit(e) and p.coverage && ssma_epi.employee_states(e.id,e.employee_state,e.unit)))))
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
 join public.ssma_profiles t on t.stock_unit=r.id and t.active and a.state=any(t.coverage)
 union select distinct t.user_id,q.project,q.state from ssma_epi.requests q join ssma_epi.regions r on r.id=q.region_id join public.ssma_profiles t on t.stock_unit=r.id and t.active and q.state=any(t.coverage)
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
 (q.created_at at time zone 'America/Sao_Paulo')::date,null,'{}'::jsonb,q.project,array(select t.user_id from public.ssma_profiles t where (t.is_master or t.stock_unit=r.id) and (t.is_master or 'epi.solicitacoes'=any(t.permissions)) and ssma_epi.request_in_area_for(q.employee_id,q.state,t.user_id)),array[q.state] from ssma_epi.requests q join ssma_epi.regions r on r.id=q.region_id
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
create or replace function ssma_epi.manage_owned(action text, p jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare
 actor uuid := auth.uid(); reg ssma_epi.regions; mat ssma_epi.materials; req ssma_epi.requests;
 line ssma_epi.lines; asset ssma_epi.assets; rec public.ssma_records; tech uuid; secret text;
 amount int; cost numeric(14,2); target text; item_id uuid; region_id_arg uuid := nullif(p->>'region_id','')::uuid;
begin
 if not exists(select 1 from public.ssma_profiles where user_id=actor) then raise exception 'Acesso restrito.'; end if;
 if action in ('material','allocate') then
   select r.* into reg from ssma_epi.regions r where r.id=region_id_arg and r.distribution_unit is not null and ssma_epi.can_use_stock(r);
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
   if not exists(select 1 from ssma_epi.regions r where r.id=dest and r.distribution_unit is not null and ssma_epi.can_use_stock(r)) then
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
create or replace function ssma_epi.workspace_owned() returns jsonb language sql stable security definer set search_path='' as $$
 with regions as (
 select r.*, p.display_name technician, p.username technician_login from ssma_epi.regions r
 join public.ssma_profiles p on p.user_id=r.technician_id where ssma_epi.can_use_stock(r)
 ), materials as (
 select m.* from ssma_epi.materials m where m.archived_at is null and ((m.region_id is null and (exists(select 1 from public.ssma_profiles t where t.user_id=auth.uid() and t.active and t.is_master))) or m.region_id in(select id from regions))
 ), requests as (
 select q.*, coalesce((select jsonb_agg(to_jsonb(l) order by l.name,l.material_id) from ssma_epi.lines l where l.request_id=q.id),'[]') items
 from ssma_epi.requests q where q.region_id in(select id from regions) and ssma_epi.request_in_area(q.employee_id,q.state)
 ), assets as (
 select a.*, coalesce((select jsonb_agg(to_jsonb(t) order by t.id desc) from ssma_epi.tests t where t.asset_id=a.id),'[]') history
 from ssma_epi.assets a where a.request_id in(select id from requests)
 )
 select jsonb_build_object(
 'regions',coalesce((select jsonb_agg(to_jsonb(r) order by r.state,r.name) from regions r),'[]'),
 'assignments',coalesce((select jsonb_agg(to_jsonb(a)||jsonb_build_object('active',e.status='Ativo','employee',e.title)) from ssma_epi.assignments a join public.ssma_records e on e.id=a.employee_id where a.region_id in(select id from regions) and ssma_epi.request_in_area(a.employee_id,a.state)),'[]'),
 'materials',coalesce((select jsonb_agg(to_jsonb(m) order by m.name,m.size,m.color) from materials m),'[]'),
 'requests',coalesce((select jsonb_agg(to_jsonb(q) order by q.created_at desc) from requests q),'[]'),
 'movements',coalesce((select jsonb_agg(to_jsonb(v) order by v.created_at desc) from ssma_epi.movements v where ((v.region_id is null and exists(select 1 from public.ssma_profiles t where t.user_id=auth.uid() and t.is_master and t.active)) or v.region_id in(select id from regions)) and (v.request_id is null or v.request_id in(select id from requests))),'[]'),
 'rules',coalesce((select jsonb_agg(to_jsonb(s)) from ssma_epi.rules s where s.material_id in(select id from materials)),'[]'),
 'assets',coalesce((select jsonb_agg(to_jsonb(a) order by a.due) from assets a),'[]')
 ) where exists(select 1 from public.ssma_profiles where user_id=auth.uid());
$$;
create or replace function ssma_epi.glove_summary(technician uuid) returns jsonb language sql stable security definer set search_path='' as $$
 select coalesce(jsonb_agg(to_jsonb(x) order by x.unit),'[]') from (
 select r.distribution_unit unit, case r.state when 'DF' then 'Centro-Oeste' when 'RJ' then 'Sudeste' else 'MATRIZ' end region, r.state,
 coalesce(sum(m.qty),0) qty, coalesce(sum(m.qty*m.price),0) cost,
 coalesce(sum(case when m.glove_start <= (now() at time zone 'America/Sao_Paulo')::date and m.expiry >= (now() at time zone 'America/Sao_Paulo')::date then m.qty-m.reserved else 0 end),0) available
 from ssma_epi.regions r left join ssma_epi.materials m on m.region_id=r.id and m.insulating_glove
 where r.distribution_unit is not null and ssma_epi.allowed('epi.estoque') and ssma_epi.can_use_stock(r) and (technician is null or exists(select 1 from public.ssma_profiles t where t.user_id=technician and (t.is_master or t.stock_unit=r.id)))
 group by r.id) x
$$;
create or replace function ssma_epi.dashboard_owned() returns table(id uuid, title text, unit text,status text,event_date date)
language sql stable security definer set search_path='' as $$
 select q.id, 'Pedido de EPI · '||q.employee, q.project, case q.status when 'Entregue' then 'Concluído' when 'Cancelado' then 'Inativo' else 'Pendente' end,
 (q.created_at at time zone 'America/Sao_Paulo')::date from ssma_epi.requests q join ssma_epi.regions r on r.id=q.region_id where ssma_epi.can_use_stock(r) and ssma_epi.request_in_area(q.employee_id,q.state)
$$;
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
 perform 1 from ssma_epi.project_units where project_key=lower(trim(emp.unit)) for share;
 select * into a from ssma_epi.assignments where employee_id=emp.id and
 (state=coalesce(nullif(p->>'state',''),emp.employee_state) or (emp.employee_state is null and not (p ? 'state') and 1=(select count(*) from ssma_epi.assignments where employee_id=emp.id)));
 if a.region_id is null and action<>'context' then raise exception 'Vínculo com a regional não encontrado.'; end if;
 select * into r from ssma_epi.regions where id=a.region_id and (distribution_unit is not null or owner_id=emp.owner_id) for share;
 select display_name into tech from public.ssma_profiles t where t.active and t.stock_unit=r.id and a.state=any(t.coverage)
 order by (t.user_id::text=emp.details->>'technicianId') desc nulls last,t.display_name,t.user_id limit 1;
 select coalesce((select display_name from public.ssma_profiles where user_id::text=emp.details->>'technicianId' and active),tech,'A definir') into tech;
 if action='context' then
 return jsonb_build_object('project',emp.unit,'job',coalesce(a.job,emp.details->>'extra'),'technician',tech,'region',r.name,
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
create or replace function ssma_epi.manage(action text,p jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare k text; project text:=lower(trim(p->>'project')); dest uuid;
begin
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
create index epi_movement_period on ssma_epi.movements(created_at,region_id);
alter table ssma_epi.sheets add column issue_hash text,
 add column expires_at timestamptz generated always as ((((issued_at at time zone 'America/Sao_Paulo') + interval '2 years') at time zone 'America/Sao_Paulo')) stored;
create index epi_sheets_expiry on ssma_epi.sheets(expires_at);
alter table ssma_epi.lines add column reason text;

create function ssma_epi.sheet_delivery(e public.ssma_records, doc_id uuid, basket jsonb) returns void
language plpgsql security definer set search_path='' as $$
declare a ssma_epi.assignments; mat ssma_epi.materials; item record; responsible text; day date:=(now() at time zone 'America/Sao_Paulo')::date;
begin
 if jsonb_array_length(basket) not between 1 and 100 or e.status is distinct from 'Ativo' or nullif(trim(e.unit),'') is null then
   raise exception 'Selecione um colaborador ativo com projeto e de 1 a 100 materiais.'; end if;
 select * into a from ssma_epi.assignments where employee_id=e.id and state=e.employee_state and region_id=ssma_epi.employee_unit(e);
 if a.region_id is null or not exists(select 1 from ssma_epi.regions r where r.id=a.region_id and ssma_epi.can_use_stock(r)) or not ssma_epi.request_in_area(e.id,a.state) then
   raise exception 'Confira a unidade do projeto e a UF do colaborador.'; end if;
 select display_name into strict responsible from public.ssma_profiles where user_id=auth.uid() and active;
 insert into ssma_epi.requests(id,owner_id,employee_id,region_id,employee,state,project,job,technician,center,contract,status,closed_at,confirmed_by,confirmed_name,destination)
 values(doc_id,e.owner_id,e.id,a.region_id,e.title,a.state,a.project,a.job,responsible,a.center,a.contract,'Entregue',now(),auth.uid(),responsible,'Projeto');
 for item in select * from jsonb_to_recordset(basket) as i(id uuid,qty int,reason text) order by id loop
   if item.reason is null or item.reason not in ('Inicial','Substituição por perda ou roubo','Substituição por período de troca/desgaste') then raise exception 'Selecione o motivo da entrega.'; end if;
   select * into mat from ssma_epi.materials where id=item.id and region_id=a.region_id and archived_at is null for update;
   if mat.id is null or item.qty is null or item.qty<1 or item.qty>mat.qty-mat.reserved or mat.expiry<day or
     (mat.insulating_glove and (mat.glove_start is null or day not between mat.glove_start and mat.glove_start+365)) then
     raise exception 'Material indisponível ou saldo insuficiente. Atualize a ficha.'; end if;
   insert into ssma_epi.lines(request_id,material_id,name,ca,size,color,qty,price,reason)
     values(doc_id,mat.id,mat.name,mat.ca,mat.size,mat.color,item.qty,mat.price,item.reason);
   update ssma_epi.materials set qty=qty-item.qty where id=mat.id;
   insert into ssma_epi.movements(owner_id,region_id,material_id,request_id,kind,qty,price)
     values(e.owner_id,a.region_id,mat.id,doc_id,'Saída',item.qty,mat.price);
 end loop;
end $$;
revoke all on function ssma_epi.sheet_delivery(public.ssma_records,uuid,jsonb) from public,anon,authenticated;
create or replace function ssma_epi.sheet(action text,p jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
 emp uuid := (p->>'employee_id')::uuid;
 actor uuid := auth.uid();
 master boolean;
 e public.ssma_records;
 doc ssma_epi.sheets;
 snap jsonb; opts jsonb; list jsonb; template jsonb; items jsonb; org text;
begin
 if not ssma_epi.allowed('epi.ficha') then raise exception 'Sem acesso à ficha digital.' using errcode='42501'; end if;
 select is_master into master from public.ssma_profiles where user_id=actor;
 if action='expiring' then
   return (select coalesce(jsonb_agg(jsonb_build_object('number',s.number,'employee',s.snapshot->>'name','expires_at',s.expires_at) order by s.expires_at),'[]')
     from ssma_epi.sheets s where s.expires_at between now() and now()+interval '72 hours'
     and (master or (s.author=actor and exists(select 1 from public.ssma_records worker where worker.id=s.employee_id and ssma_epi.record_area(worker))
       and not exists(select 1 from jsonb_array_elements(s.snapshot->'items') i where not exists(select 1 from ssma_epi.regions r where r.id=(i->>'region_id')::uuid and ssma_epi.can_use_stock(r) and ssma_epi.request_in_area(s.employee_id,i->>'state'))))));
 end if;
 if action='employees' then
   select coalesce(jsonb_agg(jsonb_build_object('id',z.id,'name',z.name) order by z.name,z.id),'[]') into list
   from (
     select distinct on (v.id) v.id,v.name from (
       select x.id,x.title as name,1 as priority from public.ssma_records x where x.module='colaboradores' and ssma_epi.record_area(x)
       union all select q.employee_id,q.employee,2 from ssma_epi.requests q join ssma_epi.regions r on r.id=q.region_id
         where q.status='Entregue' and ssma_epi.can_use_stock(r) and ssma_epi.request_in_area(q.employee_id,q.state)
       union all select s.employee_id,s.snapshot->>'name',3 from ssma_epi.sheets s where master
     ) v order by v.id,v.priority,v.name
   ) z;
   return list;
 end if;
 select x.* into e from public.ssma_records x where x.id=emp and x.module='colaboradores' and ssma_epi.record_area(x) for share;
 if e.id is null and not exists(select 1 from ssma_epi.requests q join ssma_epi.regions r on r.id=q.region_id
   where q.employee_id=emp and q.status='Entregue' and ssma_epi.can_use_stock(r) and ssma_epi.request_in_area(emp,q.state))
   and not (master and exists(select 1 from ssma_epi.sheets where employee_id=emp)) then
   raise exception 'Colaborador fora da área de atendimento.' using errcode='42501';
 end if;
 if action='issue' then
   perform pg_advisory_xact_lock(hashtextextended(p->>'id',0));
   select * into doc from ssma_epi.sheets where id=(p->>'id')::uuid;
   if found then
     if doc.employee_id=emp and doc.author=actor and doc.issue_hash=md5(p::text) then return ssma_epi.sheet('open',p); end if;
     raise exception 'Identificador de ficha já utilizado.';
   end if;
 end if;
 if action in ('open','edit','delete') then
   select s.* into doc from ssma_epi.sheets s where s.id=(p->>'id')::uuid and s.employee_id=emp
    and (master or (s.author=actor and not exists(
      select 1 from jsonb_array_elements(s.snapshot->'items') i
      where not exists(select 1 from ssma_epi.regions r where r.id=(i->>'region_id')::uuid
        and ssma_epi.can_use_stock(r) and ssma_epi.request_in_area(emp,i->>'state'))))) for update;
   if doc.id is null then raise exception 'Ficha indisponível.'; end if;
   if action='open' then return to_jsonb(doc); end if;
   if doc.revision is distinct from (p->>'revision')::int then raise exception 'A ficha foi alterada. Abra a versão atual.'; end if;
   if action='delete' then delete from ssma_epi.sheets where id=doc.id; return jsonb_build_object('ok',true); end if;
   snap:=doc.snapshot;
 elsif action in ('context','issue') then
   select coalesce(jsonb_agg(jsonb_build_object('key',q.id::text||'/'||l.material_id::text,'date',(q.closed_at at time zone 'America/Sao_Paulo')::date,
     'reason',l.reason,'ca',l.ca,'equipment',concat_ws(' · ',l.name,nullif(l.size,''),nullif(l.color,'')),'qty',l.qty,
     'state',q.state,'region_id',q.region_id,'employee',q.employee,'project',q.project,'job',q.job) order by q.closed_at,q.id,l.name,l.material_id),'[]') into items
   from ssma_epi.requests q join ssma_epi.lines l on l.request_id=q.id join ssma_epi.regions r on r.id=q.region_id
   where q.employee_id=emp and q.status='Entregue' and ssma_epi.can_use_stock(r) and ssma_epi.request_in_area(emp,q.state);
   snap:=jsonb_build_object('name',coalesce(e.title,items->-1->>'employee'),'unit',coalesce(e.unit,items->-1->>'project'),
     'job',coalesce(e.details->>'extra',items->-1->>'job'),'company',e.details->>'company','sector',e.details->>'sector',
     'cnpj',e.details->>'cnpj','registration',e.details->>'registration','cpf',e.details->>'cpf','items',items);
 else raise exception 'Operação inválida.'; end if;
 org:=coalesce(nullif(upper(regexp_replace(snap->>'cnpj','[^a-zA-Z0-9]','','g')),''),nullif(lower(trim(snap->>'company')),''));
 if action='context' then
   select coalesce(jsonb_agg(jsonb_build_object('id',s.id,'number',s.number,'issued_at',s.issued_at) order by s.number desc),'[]') into list
     from ssma_epi.sheets s where s.employee_id=emp and (master or (s.author=actor and not exists(
      select 1 from jsonb_array_elements(s.snapshot->'items') i where not exists(select 1 from ssma_epi.regions r where r.id=(i->>'region_id')::uuid
      and ssma_epi.can_use_stock(r) and ssma_epi.request_in_area(emp,i->>'state')))));
   select settings into template from ssma_epi.sheet_templates where company_key=org;
   return jsonb_build_object('snapshot',snap,'version',md5(snap::text),'sheets',list,'template',template,'materials',(select coalesce(jsonb_agg(jsonb_build_object('id',m.id,'name',concat_ws(' · ',m.name,nullif(m.size,''),nullif(m.color,'')),'available',m.qty-m.reserved) order by m.name,m.size,m.id),'[]') from ssma_epi.materials m join ssma_epi.regions r on r.id=m.region_id where e.status='Ativo' and m.region_id=ssma_epi.employee_unit(e) and exists(select 1 from ssma_epi.assignments a where a.employee_id=e.id and a.state=e.employee_state and a.region_id=r.id) and ssma_epi.can_use_stock(r) and m.archived_at is null and m.qty>m.reserved and (m.expiry is null or m.expiry>=(now() at time zone 'America/Sao_Paulo')::date) and (not m.insulating_glove or (now() at time zone 'America/Sao_Paulo')::date between m.glove_start and m.glove_start+365)));
 end if;
 if action='issue' and md5(snap::text) is distinct from p->>'version' then raise exception 'As entregas ou o cadastro mudaram. Reabra a prévia.'; end if;
 opts:=p->'settings';
 if action='issue' and jsonb_array_length(coalesce(p->'new_items','[]'))>0 then
   perform ssma_epi.sheet_delivery(e,(p->>'id')::uuid,p->'new_items');
   snap:=ssma_epi.sheet('context',p)->'snapshot';
   opts:=jsonb_set(opts,'{identity,unit}',to_jsonb(e.unit));
   opts:=jsonb_set(opts,'{reasons}',(opts->'reasons') || (select jsonb_object_agg((p->>'id')||'/'||l.material_id,l.reason) from ssma_epi.lines l where l.request_id=(p->>'id')::uuid));
 end if;
 if action='edit' and exists(select 1 from ssma_epi.requests q where q.id=doc.id) then
   opts:=jsonb_set(opts,'{identity,unit}',snap->'unit');
 end if;
 if jsonb_typeof(opts) is distinct from 'object' or jsonb_typeof(opts->'legal') is distinct from 'string'
    or jsonb_typeof(opts->'term') is distinct from 'string' or jsonb_typeof(opts->'place') is distinct from 'string'
    or length(opts->>'place')>200 or jsonb_typeof(opts->'logo') is distinct from 'string' or length(coalesce(opts->>'legal','')) not between 1 and 20000
    or length(coalesce(opts->>'term','')) not between 1 and 20000 or octet_length(opts::text)>600000
    or jsonb_typeof(opts->'reasons') is distinct from 'object'
    or (coalesce(opts->>'logo','')<>'' and (length(opts->>'logo')>350000 or opts->>'logo' !~ '^data:image/png;base64,iVBORw0KGgo[A-Za-z0-9+/=]+$')) then
    raise exception 'Confira os textos, o tamanho da logo e os motivos da ficha.'; end if;
 if jsonb_typeof(opts->'identity') is distinct from 'object' or
    exists(select 1 from jsonb_each(opts->'identity') f where jsonb_typeof(f.value)<>'string' or length(f.value#>>'{}')>254) or
    coalesce(length(trim(opts->'identity'->>'name')),0)=0 or
    exists(select 1 from jsonb_each(opts->'reasons') reason where jsonb_typeof(reason.value)<>'string' or length(reason.value#>>'{}')>300
      or not exists(select 1 from jsonb_array_elements(snap->'items') item where item->>'key'=reason.key)) then
    raise exception 'Confira a identificação do colaborador e os motivos de entrega.';
 end if;
 if action='issue' then
   insert into ssma_epi.sheets(id,employee_id,author,snapshot,settings,issue_hash) values((p->>'id')::uuid,emp,actor,snap,opts,md5(p::text))
   on conflict(id) do nothing returning * into doc;
   if not found then
     select * into doc from ssma_epi.sheets where id=(p->>'id')::uuid and author=actor and employee_id=emp and snapshot=snap and settings=opts;
     if not found then raise exception 'Identificador de ficha já utilizado.'; end if;
   end if;
 else
   update ssma_epi.sheets set settings=opts,revision=revision+1 where id=doc.id returning * into doc;
 end if;
 if (p->>'save_template')::boolean then
   if not master or org is null then raise exception 'Para salvar o modelo, informe a empresa ou CNPJ no cadastro e use o acesso Master.'; end if;
   insert into ssma_epi.sheet_templates values(org,jsonb_build_object('legal',opts->>'legal','term',opts->>'term','logo',opts->>'logo'))
   on conflict(company_key) do update set settings=excluded.settings;
 end if;
 return to_jsonb(doc);
end $$;
