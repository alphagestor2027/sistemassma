alter table public.ssma_records add column dismissed_at timestamptz;
update public.ssma_records set dismissed_at=now() where module='colaboradores' and status='Inativo';
create function ssma_epi.track_dismissal() returns trigger language plpgsql set search_path='' as $$
begin
 if new.module='colaboradores' and new.status='Inativo' then
   new.dismissed_at:=case when tg_op='UPDATE' and old.status='Inativo' then coalesce(old.dismissed_at,now()) else now() end;
 else new.dismissed_at:=null; end if;
 return new;
end $$;
create trigger track_dismissal before insert or update on public.ssma_records for each row execute function ssma_epi.track_dismissal();
create index ssma_employee_expiry on public.ssma_records(dismissed_at) where dismissed_at is not null;
create function ssma_epi.expire_employees() returns void language plpgsql set search_path='' as $$
declare e uuid; q uuid;
begin
 for e in select id from public.ssma_records where module='colaboradores' and status='Inativo' and dismissed_at<=now()-interval '2 years' order by id for update loop
   for q in select id from ssma_epi.requests where employee_id=e and status='Solicitado' order by id for update loop
     update ssma_epi.materials m set reserved=m.reserved-l.qty from ssma_epi.lines l where l.request_id=q and l.material_id=m.id;
     update ssma_epi.requests set status='Cancelado',closed_at=now() where id=q;
   end loop;
   update ssma_epi.requests set employee='Colaborador removido',employee_id=gen_random_uuid(),management_note='',list_removed=true where employee_id=e;
   update ssma_epi.shipments set recipient='Colaborador removido',employee_id=null where employee_id=e;
   delete from ssma_epi.sheets where employee_id=e;
   update public.ssma_records set employee_id=null where employee_id=e;
   delete from public.ssma_records where id=e;
 end loop;
end $$;
revoke all on function ssma_epi.expire_employees() from public,anon,authenticated;
select cron.schedule('ssma-expirar-colaboradores','*/5 * * * *',$job$select ssma_epi.expire_employees()$job$);

create function public.ssma_employee_history(p_employee uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if not ssma_epi.allowed('colaboradores') or not exists(select 1 from public.ssma_records e where e.id=p_employee and e.module='colaboradores' and ssma_epi.record_area(e)) then raise insufficient_privilege; end if;
 return jsonb_build_object('deliveries',coalesce((select jsonb_agg(to_jsonb(d) order by day desc,name) from (
 select l.name,l.ca,l.size,l.color,l.qty,l.material_id,(q.closed_at at time zone 'America/Sao_Paulo')::date as day,
 ((q.closed_at at time zone 'America/Sao_Paulo')::date+365) due,q.postal,
 coalesce((select min(s.sent) from ssma_epi.shipments s where s.employee_id=q.employee_id and s.unit_id=q.region_id and nullif(upper(trim(q.postal)),'')=upper(trim(s.tracking)) and ssma_epi.request_in_area(s.employee_id,s.state)),
 (select min(((event->>'date')::timestamptz at time zone 'America/Sao_Paulo')::date) from jsonb_array_elements(q.events) event where event->>'stage'='Enviado pelos Correios')) as sent
 from ssma_epi.requests q join ssma_epi.lines l on l.request_id=q.id join ssma_epi.regions r on r.id=q.region_id
 where q.employee_id=p_employee and q.status='Entregue' and ssma_epi.can_use_stock(r) and ssma_epi.request_in_area(q.employee_id,q.state)) d),'[]'),
 'shipments',coalesce((select jsonb_agg(jsonb_build_object('sent',s.sent,'tracking',s.tracking,'mode',s.mode) order by s.sent desc)
 from ssma_epi.shipments s join ssma_epi.regions r on r.id=s.unit_id where s.employee_id=p_employee and ssma_epi.can_use_stock(r) and ssma_epi.request_in_area(s.employee_id,s.state)),'[]'));
end $$;
revoke all on function public.ssma_employee_history(uuid) from public,anon;
grant execute on function public.ssma_employee_history(uuid) to authenticated;
