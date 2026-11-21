create function ssma_epi.assign_employee_technician() returns trigger
language plpgsql security definer set search_path = '' as $$
declare actor public.ssma_profiles;
begin
  select * into actor from public.ssma_profiles where user_id = auth.uid() and active;
  if not found or actor.is_master then return new; end if;
  if tg_op = 'INSERT' or old.module <> 'colaboradores' then
    new.details := new.details || jsonb_build_object('technicianId', actor.user_id);
    new.person := actor.display_name;
  else
    new.details := (new.details - 'technicianId') ||
      case when old.details ? 'technicianId' then jsonb_build_object('technicianId', old.details->'technicianId') else '{}'::jsonb end;
    new.person := old.person;
  end if;
  return new;
end $$;
create trigger assign_employee_technician before insert or update on public.ssma_records
for each row when (new.module = 'colaboradores') execute function ssma_epi.assign_employee_technician();

-- Preserve the certificate date at handover, for both direct sheets and fulfilled orders.
alter table ssma_epi.lines add column delivered_glove boolean not null default false,
  add column glove_due date;
update ssma_epi.lines l set delivered_glove = true,
  glove_due = case when m.glove_start <= (q.closed_at at time zone 'America/Sao_Paulo')::date then m.glove_start + 365 end
from ssma_epi.requests q, ssma_epi.materials m
where q.id = l.request_id and q.status = 'Entregue' and m.id = l.material_id and m.insulating_glove;

create function ssma_epi.capture_glove_due() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  select m.insulating_glove, case when m.insulating_glove then m.glove_start + 365 end
    into strict new.delivered_glove, new.glove_due from ssma_epi.materials m where m.id = new.material_id;
  return new;
end $$;
create trigger capture_glove_due before insert or update of price on ssma_epi.lines
for each row when (new.price is not null) execute function ssma_epi.capture_glove_due();

create function ssma_epi.technician_gloves() returns jsonb
language sql stable security definer set search_path = '' as $$
  with deliveries as (
    select e.id as employee_id, e.title as employee, coalesce(e.employee_state,q.state) as state,
      l.request_id, l.material_id, l.name as material, l.qty, l.glove_due
    from ssma_epi.lines l
    join ssma_epi.requests q on q.id = l.request_id and q.status = 'Entregue'
    join public.ssma_records e on e.id = q.employee_id and e.module = 'colaboradores' and e.status = 'Ativo'
    join ssma_epi.regions r on r.id = q.region_id
    join public.ssma_profiles p on p.user_id = auth.uid() and p.active and not p.is_master
    where l.delivered_glove and p.permissions && array['epi.estoque','epi.ensaios','epi.solicitacoes','epi.ficha']
      and coalesce(e.employee_state,q.state) = any(p.coverage)
      and ssma_epi.can_use_stock(r) and ssma_epi.request_in_area(e.id,q.state)
  ), tracked as (
    select d.request_id, d.material_id, a.id, a.status = 'Reprovado' as rejected,
      case when renewal.day is null then d.glove_due else least(a.due, renewal.day + 365) end as due
    from deliveries d join ssma_epi.assets a using (request_id, material_id)
    left join lateral (
      select (max(t.created_at) at time zone 'America/Sao_Paulo')::date as day
      from ssma_epi.tests t where t.asset_id = a.id and t.status = 'Em retorno'
    ) renewal on true
  ), assigned_counts as (
    select request_id, material_id, count(*) as qty from tracked group by request_id, material_id
  ), quantities as (
    select d.*, t.due, t.rejected, 1 as quantity
    from deliveries d join tracked t using (request_id, material_id)
    union all
    select d.*, d.glove_due, false, d.qty - coalesce(c.qty, 0) as quantity
    from deliveries d left join assigned_counts c using (request_id, material_id)
  ), summary as (
    select employee_id, employee, state, material_id, material, due, rejected, sum(quantity)::int as qty
    from quantities where quantity > 0
    group by employee_id, employee, state, material_id, material, due, rejected
  )
  select coalesce(jsonb_agg(to_jsonb(s) - 'employee_id' - 'material_id'
    order by rejected desc, due nulls last, employee, material, employee_id, material_id), '[]'::jsonb) from summary s
$$;
create function public.ssma_epi_technician_gloves() returns jsonb
language sql stable security invoker set search_path = '' as $$
  select ssma_epi.technician_gloves()
$$;
revoke all on function ssma_epi.technician_gloves(), ssma_epi.assign_employee_technician(), ssma_epi.capture_glove_due(),
  public.ssma_epi_technician_gloves() from public, anon, authenticated;
grant execute on function ssma_epi.technician_gloves(), public.ssma_epi_technician_gloves() to authenticated;
