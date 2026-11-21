alter table ssma_epi.requests add column list_removed boolean not null default false,
 add column management_note text not null default '';

alter function ssma_epi.manage(text,jsonb) rename to manage_before_request_list;
create function ssma_epi.manage(action text,p jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare q ssma_epi.requests; l ssma_epi.lines; n integer; count_changed integer:=0;
begin
 if action='material' and p ? 'master_unit' then
   if not exists(select 1 from public.ssma_profiles where user_id=auth.uid() and active and is_master)
      or not exists(select 1 from ssma_epi.regions where id=(p->>'master_unit')::uuid and distribution_unit is not null)
   then raise exception 'Selecione uma unidade autorizada pelo Master.'; end if;
   return ssma_epi.manage_owned(action,p||jsonb_build_object('region_id',p->>'master_unit'));
 end if;
 if action not in ('edit_request','remove_request','clear_requests') then
   return ssma_epi.manage_before_request_list(action,p);
 end if;
 if not ssma_epi.allowed('epi.solicitacoes') then raise exception 'Sem permissão para gerenciar solicitações.'; end if;
 for q in select s.* from ssma_epi.requests s join ssma_epi.regions r on r.id=s.region_id
   where not s.list_removed and ssma_epi.can_use_stock(r) and ssma_epi.request_in_area(s.employee_id,s.state)
   and (action='clear_requests' or s.id=(p->>'request_id')::uuid) order by s.id for update of s
 loop
   if action='edit_request' then
     if q.status is distinct from p->>'status' or q.management_note is distinct from p->>'previous_note'
       or q.postal is distinct from p->>'previous_postal' then raise exception 'Solicitação alterada. Atualize a lista.'; end if;
     if length(p->>'note')>500 or length(p->>'postal')>64 then raise exception 'Texto muito longo.'; end if;
     if q.status='Solicitado' then
       for l in select * from ssma_epi.lines where request_id=q.id order by material_id loop
         n:=(p->'quantities'->>l.material_id::text)::integer;
         if n is null or n<1 or l.qty is distinct from (p->'previous_qty'->>l.material_id::text)::integer then raise exception 'Confira as quantidades e atualize a lista.'; end if;
         update ssma_epi.materials set reserved=reserved+(n-l.qty) where id=l.material_id and qty-reserved>=n-l.qty;
         if not found then raise exception 'Saldo insuficiente para alterar a reserva.'; end if;
         update ssma_epi.lines set qty=n where request_id=q.id and material_id=l.material_id;
       end loop;
     end if;
     update ssma_epi.requests set management_note=coalesce(p->>'note',''),postal=coalesce(p->>'postal','') where id=q.id;
   else
     if q.status='Solicitado' then perform ssma_epi.manage_before_request_list('cancel',jsonb_build_object('request_id',q.id)); end if;
     update ssma_epi.requests set list_removed=true where id=q.id;
   end if;
   count_changed:=count_changed+1;
 end loop;
 if count_changed=0 and action<>'clear_requests' then raise exception 'Solicitação indisponível.'; end if;
 return jsonb_build_object('count',count_changed);
end $$;
revoke all on function ssma_epi.manage(text,jsonb) from public,anon;
grant execute on function ssma_epi.manage(text,jsonb) to authenticated;
