alter table public.ssma_profiles add column removed_at timestamptz,
 add constraint ssma_removed_profile_inactive check (removed_at is null or (not active and not is_master));

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
 update public.ssma_profiles set display_name=trim(p->>'name'),active=(p->>'active')::boolean,
 coverage=case when p ? 'coverage' then array(select jsonb_array_elements_text(p->'coverage')) else coverage end
 where user_id=(p->>'technician')::uuid and not is_master and removed_at is null and display_name=p->>'previous_name' and active=(p->>'previous_active')::boolean
 and (not (p ? 'coverage') or coverage=array(select jsonb_array_elements_text(p->'previous_coverage')));
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
 select distinct r.technician_id tech,a.project,a.state from ssma_epi.assignments a join ssma_epi.regions r on r.id=a.region_id
 union select distinct r.technician_id,q.project,q.state from ssma_epi.requests q join ssma_epi.regions r on r.id=q.region_id
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
 (q.created_at at time zone 'America/Sao_Paulo')::date,null,'{}'::jsonb,q.project,array(select t.user_id from public.ssma_profiles t where t.user_id in(r.owner_id,r.technician_id) and (t.is_master or 'epi.solicitacoes'=any(t.permissions)) and ssma_epi.request_in_area_for(q.employee_id,q.state,t.user_id)),array[q.state] from ssma_epi.requests q join ssma_epi.regions r on r.id=q.region_id
 ), projects as (
 select distinct who.tech, x.unit as project, coalesce(uf.state,'Sem UF informada') as state
 from rows x cross join lateral unnest(x.techs) who(tech) cross join lateral unnest(x.states) uf(state)
 join public.ssma_profiles t on t.user_id=who.tech
 where trim(x.unit)<>'' and (t.is_master or uf.state is null or uf.state=any(t.coverage))
 union select a.tech,a.project,a.state from assigned a join public.ssma_profiles t on t.user_id=a.tech
 where t.active and (t.is_master or a.state=any(t.coverage))
 )
 select jsonb_build_object('service_areas',ssma_epi.service_areas(),'people',(select jsonb_agg(jsonb_build_object('id',user_id,'name',display_name,'master',is_master,'username',username,'coverage',coverage,'active',active,'permissions',permissions) order by display_name) from public.ssma_profiles where removed_at is null),
 'rows',coalesce((select jsonb_agg(to_jsonb(x)) from rows x),'[]'),'projects',coalesce((select jsonb_agg(to_jsonb(v) order by state,project) from projects v),'[]')) into result;
 return result;
end $$;
