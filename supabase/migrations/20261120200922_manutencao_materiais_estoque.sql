alter table ssma_epi.materials
  add column archived_at timestamptz,
  add column revision bigint not null default 0,
  add check (archived_at is null or (qty = 0 and reserved = 0));

create function ssma_epi.material_revision() returns trigger language plpgsql set search_path='' as $$
begin
  if old.archived_at is not null then raise exception 'Este material foi excluído.'; end if;
  new.revision := old.revision + 1;
  return new;
end $$;
create trigger material_revision before update on ssma_epi.materials
  for each row execute function ssma_epi.material_revision();

alter table ssma_epi.movements drop constraint movements_kind_check,
  add check(kind in ('Entrada','Saída','Ajuste de entrada','Ajuste de saída')),
  add column material_label jsonb;
update ssma_epi.movements v set material_label=jsonb_build_object('name',m.name,'size',m.size,'color',m.color)
from ssma_epi.materials m where m.id=v.material_id;
create function ssma_epi.movement_label() returns trigger language plpgsql set search_path='' as $$
begin
 if new.material_label is null then
   select jsonb_build_object('name',m.name,'size',m.size,'color',m.color) into new.material_label
   from ssma_epi.materials m where m.id=new.material_id;
 end if;
 return new;
end $$;
create trigger movement_label before insert on ssma_epi.movements for each row execute function ssma_epi.movement_label();

create function ssma_epi.maintain_material(action text,p jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
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
revoke all on function ssma_epi.material_revision(),ssma_epi.movement_label(),ssma_epi.maintain_material(text,jsonb) from public,anon,authenticated;

create or replace function ssma_epi.manage(action text,p jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare k text; project text:=lower(trim(p->>'project')); dest uuid;
begin
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
 when action in('region','assignment') then 'regionais' when action='rule' then 'compras' when action in('asset','test') then 'ensaios' end;
 if k is null or not ssma_epi.allowed('epi.'||k) then raise exception 'Sem permissão para esta operação.'; end if;
 if action in ('progress','deliver','cancel','asset','test') and not exists(select 1 from ssma_epi.requests q where q.id=case when action='test' then (select a.request_id from ssma_epi.assets a where a.id=(p->>'asset_id')::uuid) else (p->>'request_id')::uuid end and ssma_epi.request_in_area(q.employee_id,q.state)) then raise exception 'Pedido fora da área de atendimento.'; end if;
 if action='rule' then
   perform 1 from ssma_epi.materials where id=(p->>'material_id')::uuid and archived_at is null for share;
   if not found then raise exception 'Material indisponível.'; end if;
 end if;
 return ssma_epi.manage_owned(action,p);
end $$;
create or replace function ssma_epi.workspace_owned() returns jsonb language sql stable security definer set search_path='' as $$
 with regions as (
 select r.*, p.display_name technician, p.username technician_login from ssma_epi.regions r
 join public.ssma_profiles p on p.user_id=r.technician_id where ssma_epi.can_use_stock(r)
 ), materials as (
 select m.* from ssma_epi.materials m where m.archived_at is null and ((m.region_id is null and (m.owner_id=auth.uid() or exists(select 1 from public.ssma_profiles t where t.user_id=auth.uid() and t.active and t.is_master))) or m.region_id in(select id from regions))
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
 'movements',coalesce((select jsonb_agg(to_jsonb(v) order by v.created_at desc) from ssma_epi.movements v where (v.owner_id=auth.uid() or v.region_id in(select id from regions)) and (v.request_id is null or v.request_id in(select id from requests))),'[]'),
 'rules',coalesce((select jsonb_agg(to_jsonb(s)) from ssma_epi.rules s where s.material_id in(select id from materials)),'[]'),
 'assets',coalesce((select jsonb_agg(to_jsonb(a) order by a.due) from assets a),'[]')
 ) where exists(select 1 from public.ssma_profiles where user_id=auth.uid());
$$;
