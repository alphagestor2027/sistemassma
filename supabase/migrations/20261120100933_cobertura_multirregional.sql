create function ssma_epi.legacy_coverage(region text,state text) returns text[] language sql immutable set search_path='' as $$
 select case when nullif(state,'') is not null then array[state] else array(select jsonb_array_elements_text(ssma_epi.service_areas()->region)) end
$$;
alter table public.ssma_profiles add column coverage text[] not null default '{}'
 check(coverage <@ array['AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG','PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO'] and array_position(coverage,null) is null);
update public.ssma_profiles set coverage=ssma_epi.legacy_coverage(service_region,service_state);
alter table public.ssma_records add column employee_state text check(employee_state in ('AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG','PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO')),
 add column employee_id uuid references public.ssma_records(id) on delete restrict;
create index ssma_linked_employee on public.ssma_records(employee_id) where employee_id is not null;
-- Link earlier free-text references only if the owner has exactly one matching employee.
with names as (select owner_id,lower(trim(title)) as name,min(id::text)::uuid as id from public.ssma_records where module='colaboradores' group by 1,2 having count(*)=1)
update public.ssma_records x set employee_id=n.id from names n where x.module<>'colaboradores' and x.owner_id=n.owner_id and lower(trim(x.person))=n.name;

create function ssma_epi.employee_states(employee uuid,state text,unit text) returns text[] language sql stable security definer set search_path='' as $$
 select case when state is not null then array[state] else coalesce((select array_agg(a.state) from ssma_epi.assignments a where a.employee_id=employee),
 array[substring(upper(trim(unit)) from '/[[:space:]]*([A-Z]{2})$')]) end
$$;
create function ssma_epi.request_in_area_for(employee uuid, uf text, actor uuid) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.ssma_profiles p where p.user_id=actor and p.active and (p.is_master or
 (uf=any(p.coverage) and exists(select 1 from public.ssma_records e where e.id=employee and e.module='colaboradores' and p.coverage && ssma_epi.employee_states(e.id,e.employee_state,e.unit)))))
$$;
create function ssma_epi.record_area_for(x public.ssma_records,actor uuid) returns boolean language plpgsql stable security definer set search_path='' as $$
declare p public.ssma_profiles; e public.ssma_records;
begin
 select * into p from public.ssma_profiles where user_id=actor and active;
 if p.user_id is null then return false; end if;
 if p.is_master then return true; end if;
 if x.module='colaboradores' then return p.coverage && ssma_epi.employee_states(x.id,x.employee_state,x.unit); end if;
 if x.employee_id is not null then select * into e from public.ssma_records where id=x.employee_id and module='colaboradores';
 elsif trim(x.person)<>'' then
 begin
 select * into strict e from public.ssma_records where owner_id=x.owner_id and module='colaboradores' and lower(trim(title))=lower(trim(x.person));
 exception when no_data_found then
 select * into strict e from public.ssma_records where module='colaboradores' and lower(trim(title))=lower(trim(x.person));
 end;
 else return x.owner_id=p.user_id; end if;
 return e.id is not null and p.coverage && ssma_epi.employee_states(e.id,e.employee_state,e.unit);
exception when no_data_found then return x.owner_id=p.user_id; when too_many_rows then return false;
end $$;
create function ssma_epi.record_area(x public.ssma_records) returns boolean language sql stable security definer set search_path='' as $$ select ssma_epi.record_area_for(x,auth.uid()) $$;
create function ssma_epi.request_in_area(employee uuid,uf text) returns boolean language sql stable security definer set search_path='' as $$ select ssma_epi.request_in_area_for(employee,uf,auth.uid()) $$;
revoke all on function ssma_epi.request_in_area_for(uuid,text,uuid),ssma_epi.record_area_for(public.ssma_records,uuid) from public,anon,authenticated;
-- Read across owners only for identifiable employee records inside the granted area.
create policy regional_linked_read on public.ssma_records for select to authenticated
 using ((module='colaboradores' or employee_id is not null) and ssma_epi.record_area(ssma_records));
create policy regional_boundary on public.ssma_records as restrictive for all to authenticated
 using(ssma_epi.record_area(ssma_records)) with check(ssma_epi.record_area(ssma_records));
revoke all on function ssma_epi.employee_states(uuid,text,text),ssma_epi.request_in_area(uuid,text),ssma_epi.legacy_coverage(text,text),ssma_epi.record_area(public.ssma_records) from public,anon,authenticated;
grant execute on function ssma_epi.record_area(public.ssma_records) to authenticated;

create or replace function ssma_epi.on_technician_created() returns trigger language plpgsql security definer set search_path='' as $$
declare info jsonb:=new.raw_app_meta_data->'ssma_technician'; login text:=split_part(new.email,'@',1);
begin
 if info is null then return new; end if;
 if tg_op='UPDATE' and old.raw_app_meta_data->'ssma_technician' is not null then return new; end if;
 if not exists(select 1 from public.ssma_profiles where user_id=(info->>'created_by')::uuid and is_master and active)
 or login!~'^[a-z0-9][a-z0-9._-]{2,39}$' or login='cesar' or new.email<>login||'@ssma.invalid'
 or nullif(trim(info->>'name'),'') is null or length(trim(info->>'name'))>120 then raise exception 'Cadastro de técnico inválido.'; end if;
 insert into public.ssma_profiles(user_id,username,display_name,coverage)
 values(new.id,login,trim(info->>'name'),case when info ? 'coverage' then array(select jsonb_array_elements_text(info->'coverage')) else ssma_epi.legacy_coverage(info->>'service_region',info->>'service_state') end);
 return new;
end $$;


create or replace function ssma_epi.workspace_owned() returns jsonb language sql stable security definer set search_path='' as $$
 with regions as (
 select r.*, p.display_name technician, p.username technician_login from ssma_epi.regions r
 join public.ssma_profiles p on p.user_id=r.technician_id where auth.uid() in(r.owner_id,r.technician_id)
 ), materials as (
 select m.* from ssma_epi.materials m where m.owner_id=auth.uid() or m.region_id in(select id from regions)
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


create or replace function ssma_epi.dashboard_owned() returns table(id uuid, title text, unit text,status text,event_date date)
language sql stable security definer set search_path='' as $$
 select q.id, 'Pedido de EPI · '||q.employee, q.project, case q.status when 'Entregue' then 'Concluído' when 'Cancelado' then 'Inativo' else 'Pendente' end,
 (q.created_at at time zone 'America/Sao_Paulo')::date from ssma_epi.requests q join ssma_epi.regions r on r.id=q.region_id where auth.uid() in(r.owner_id,r.technician_id) and ssma_epi.request_in_area(q.employee_id,q.state)
$$;

create or replace function ssma_epi.manage(action text,p jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare k text;
begin
 k:=case when action in('entry','material','allocate') then 'estoque' when action in('deliver','cancel','progress') then 'solicitacoes'
 when action in('region','assignment') then 'regionais' when action='rule' then 'compras' when action in('asset','test') then 'ensaios' end;
 if k is null or not ssma_epi.allowed('epi.'||k) then raise exception 'Sem permissão para esta operação.'; end if;
 if action='assignment' and not exists(select 1 from ssma_epi.regions r where r.id=(p->>'region_id')::uuid and ssma_epi.request_in_area((p->>'employee_id')::uuid,r.state)) then raise exception 'Colaborador fora da área de atendimento.'; end if;
 if action in ('progress','deliver','cancel','asset','test') and not exists(select 1 from ssma_epi.requests q where q.id=case when action='test' then (select a.request_id from ssma_epi.assets a where a.id=(p->>'asset_id')::uuid) else (p->>'request_id')::uuid end and ssma_epi.request_in_area(q.employee_id,q.state)) then raise exception 'Pedido fora da área de atendimento.'; end if;
 return ssma_epi.manage_owned(action,p);
end $$;

create or replace function ssma_epi.master(action text,p jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
 if not exists(select 1 from public.ssma_profiles where user_id=auth.uid() and is_master and active) then raise exception 'Acesso exclusivo do Master.'; end if;
 if action='authorize_creation' then return to_jsonb(auth.uid()); end if;
 if action='edit_technician' then
 if p ? 'service_region' and not (p ? 'coverage') then raise exception 'Atualize a página para editar a área de atendimento.'; end if;
 if nullif(trim(p->>'name'),'') is null or length(trim(p->>'name'))>120 then raise exception 'Informe um nome de até 120 caracteres.'; end if;
 update public.ssma_profiles set display_name=trim(p->>'name'),active=(p->>'active')::boolean,
 coverage=case when p ? 'coverage' then array(select jsonb_array_elements_text(p->'coverage')) else coverage end
 where user_id=(p->>'technician')::uuid and not is_master and display_name=p->>'previous_name' and active=(p->>'previous_active')::boolean
 and (not (p ? 'coverage') or coverage=array(select jsonb_array_elements_text(p->'previous_coverage')));
 if not found then raise exception 'Cadastro alterado. Atualize a lista de técnicos.'; end if;
 return 'true'::jsonb;
 end if;
 if action='permissions' then
 update public.ssma_profiles set permissions=array(select distinct jsonb_array_elements_text(p->'permissions'))
 where user_id=(p->>'technician')::uuid and not is_master and permissions=array(select jsonb_array_elements_text(p->'previous'));
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
 select jsonb_build_object('service_areas',ssma_epi.service_areas(),'people',(select jsonb_agg(jsonb_build_object('id',user_id,'name',display_name,'master',is_master,'username',username,'coverage',coverage,'active',active,'permissions',permissions) order by display_name) from public.ssma_profiles),
 'rows',coalesce((select jsonb_agg(to_jsonb(x)) from rows x),'[]'),'projects',coalesce((select jsonb_agg(to_jsonb(v) order by state,project) from projects v),'[]')) into result;
 return result;
end $$;
