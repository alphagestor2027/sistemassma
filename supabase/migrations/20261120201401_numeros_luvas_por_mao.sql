alter table ssma_epi.materials
  add column glove_left_number varchar(100),
  add column glove_right_number varchar(100),
  add check (insulating_glove or (glove_left_number is null and glove_right_number is null));

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
 when 'region' then
   if not exists(select 1 from public.ssma_profiles where user_id=actor and active and is_master) then raise exception 'Somente o Master pode alterar o responsável da unidade.'; end if;
   select user_id into strict tech from public.ssma_profiles where username=lower(trim(p->>'login')) and active and removed_at is null;
   update ssma_epi.regions set technician_id=tech where id=region_id_arg and distribution_unit is not null;
   if not found then raise exception 'Unidade de distribuição inválida.'; end if;
 when 'assignment' then
   select * into strict rec from public.ssma_records where id=(p->>'employee_id')::uuid and module='colaboradores' and status='Ativo';
   insert into ssma_epi.legacy_assignments(employee_id,state,region_id,project,job,center,contract)
   select a.employee_id,a.state,a.region_id,a.project,a.job,trim(coalesce(p->>'center','')),trim(coalesce(p->>'contract',''))
   from ssma_epi.assignments a where a.employee_id=rec.id and a.region_id=region_id_arg and ssma_epi.request_in_area(a.employee_id,a.state)
   on conflict(employee_id,state) do update set center=excluded.center,contract=excluded.contract;
   if not found then raise exception 'Configure a unidade do projeto e a UF do colaborador.'; end if;
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
 (t.is_master or (ssma_epi.can_use_stock(r) or (m.region_id is null and m.owner_id=actor))));
 if not found then raise exception 'Lote indisponível ou já atualizado.'; end if;
 when 'entry','allocate','rule' then
 select * into strict mat from ssma_epi.materials where id=(p->>'material_id')::uuid and ((region_id is null and (owner_id=actor or exists(select 1 from public.ssma_profiles where user_id=actor and is_master and active))) or region_id in(select r.id from ssma_epi.regions r where ssma_epi.can_use_stock(r))) for update;
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
 where q.id=(p->>'request_id')::uuid and r.technician_id=actor for update of q;
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
 where q.id=(p->>'request_id')::uuid and (r.technician_id=actor or (action='cancel' and r.owner_id=actor)) for update of q;
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
 where q.id=(p->>'request_id')::uuid and actor in(r.owner_id,r.technician_id) and q.status='Entregue' for update of q;
 item_id:=(p->>'material_id')::uuid;
 select * into strict line from ssma_epi.lines where request_id=req.id and material_id=item_id;
 if (select count(*) from ssma_epi.assets where request_id=req.id and material_id=item_id)>=line.qty then raise exception 'Todas as unidades da entrega já têm série.'; end if;
 insert into ssma_epi.assets(owner_id,request_id,material_id,serial,period_days,due) values(req.owner_id,req.id,item_id,trim(p->>'serial'),(p->>'days')::int,(p->>'due')::date);
 when 'test' then
 select a.* into strict asset from ssma_epi.assets a join ssma_epi.requests q on q.id=a.request_id join ssma_epi.regions r on r.id=q.region_id
 where a.id=(p->>'asset_id')::uuid and actor in(r.owner_id,r.technician_id) for update of a;
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
 ((s.region_id is null and exists(select 1 from public.ssma_profiles t where t.user_id=auth.uid() and t.active and (t.is_master or t.user_id=s.owner_id)))
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
