alter table public.ssma_profiles
 add column is_master boolean not null default false,
 add column permissions text[] not null default '{}';
alter table public.ssma_profiles add constraint ssma_permissions_valid check
 (permissions <@ array['colaboradores','exames','prontuarios','afastamentos','ergonomia','riscos','acidentes','pt','inspecoes','licencas','residuos','emissoes','laia','esocial','treinamentos','terceiros','requisitos','bi','epi.estoque','epi.solicitacoes','epi.financeiro','epi.ficha','epi.ensaios','epi.compras','epi.regionais','epi.anteriores' ]::text[] and array_position(permissions,null) is null);
update public.ssma_profiles set permissions=array['colaboradores','exames','prontuarios','afastamentos','ergonomia','riscos','acidentes','pt','inspecoes','licencas','residuos','emissoes','laia','esocial','treinamentos','terceiros','requisitos','bi','epi.estoque','epi.solicitacoes','epi.financeiro','epi.ficha','epi.ensaios','epi.compras','epi.regionais','epi.anteriores'];
update public.ssma_profiles set is_master=true where username='cesar';

create function ssma_epi.allowed(k text) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.ssma_profiles where user_id=auth.uid() and (is_master or k=any(permissions)))
$$;
create policy ssma_module_permissions on public.ssma_records as restrictive for all to authenticated
 using(ssma_epi.allowed(case when module='epis' then 'epi.anteriores' else module end))
 with check(ssma_epi.allowed(case when module='epis' then 'epi.anteriores' else module end));

alter function ssma_epi.manage(text,jsonb) rename to manage_owned;
alter function ssma_epi.workspace() rename to workspace_owned;
alter function ssma_epi.dashboard() rename to dashboard_owned;
revoke all on function ssma_epi.manage_owned(text,jsonb),ssma_epi.workspace_owned(),ssma_epi.dashboard_owned() from public,anon,authenticated;

create function ssma_epi.manage(action text,p jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare k text;
begin
 k:=case when action in('entry','material','allocate') then 'estoque' when action in('deliver','cancel','progress') then 'solicitacoes'
 when action in('region','assignment') then 'regionais' when action='rule' then 'compras' when action in('asset','test') then 'ensaios' end;
 if k is null or not ssma_epi.allowed('epi.'||k) then raise exception 'Sem permissão para esta operação.'; end if;
 return ssma_epi.manage_owned(action,p);
end $$;
create function ssma_epi.workspace() returns jsonb language plpgsql stable security definer set search_path='' as $$
declare d jsonb; f boolean:=ssma_epi.allowed('epi.financeiro'); stock boolean:=ssma_epi.allowed('epi.estoque');
 plan boolean:=ssma_epi.allowed('epi.compras'); regions boolean:=ssma_epi.allowed('epi.regionais'); tests boolean:=ssma_epi.allowed('epi.ensaios');
 orders boolean:=ssma_epi.allowed('epi.solicitacoes'); sheet boolean:=ssma_epi.allowed('epi.ficha'); qs jsonb;
begin
 if not (f or stock or plan or regions or tests or orders or sheet) then return null; end if;
 d:=ssma_epi.workspace_owned();
 select coalesce(jsonb_agg(case when f then q else (q-'items')||jsonb_build_object('items',(select jsonb_agg(i-'price') from jsonb_array_elements(q->'items') i)) end),'[]') into qs
 from jsonb_array_elements(d->'requests') q where f or orders or plan or ((sheet or tests) and q->>'status'='Entregue');
 return jsonb_build_object('requests',qs,'regions',d->'regions','movements',case when f then d->'movements' else '[]'::jsonb end,
 'materials',case when stock or plan then d->'materials' when f then (select coalesce(jsonb_agg(jsonb_build_object('id',m->'id','name',m->'name','size',m->'size','color',m->'color')),'[]') from jsonb_array_elements(d->'materials') m) else '[]'::jsonb end,
 'assets',case when tests then d->'assets' else '[]'::jsonb end,'rules',case when plan then d->'rules' else '[]'::jsonb end,
 'assignments',case when regions or plan then d->'assignments' else '[]'::jsonb end);
end $$;
create function ssma_epi.dashboard() returns table(id uuid,title text,unit text,status text,event_date date) language sql stable security definer set search_path='' as $$
 select * from ssma_epi.dashboard_owned() where ssma_epi.allowed('epi.solicitacoes')
$$;
create function ssma_epi.master(action text,p jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
 if not exists(select 1 from public.ssma_profiles where user_id=auth.uid() and is_master) then raise exception 'Acesso exclusivo do Master.'; end if;
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
 ), projects as (
 select * from assigned
 union select distinct x.owner_id,x.unit,coalesce(substring(x.unit from '/[[:space:]]*(AC|AL|AP|AM|BA|CE|DF|ES|GO|MA|MT|MS|MG|PA|PB|PR|PE|PI|RJ|RN|RS|RO|RR|SC|SP|SE|TO)$'),'Sem UF informada')
 from public.ssma_records x where trim(x.unit)<>'' and not exists(select 1 from assigned a where a.tech=x.owner_id and a.project=x.unit)
 ), rows as (
 select x.module,x.status,x.event_date,x.due_date,jsonb_build_object('extra',x.details->>'extra') details,x.unit,
 array[x.owner_id] techs,array(select distinct v.state from projects v where v.tech=x.owner_id and v.project=x.unit) states
 from public.ssma_records x
 union all select 'epis',case q.status when 'Entregue' then 'Concluído' when 'Cancelado' then 'Inativo' else 'Pendente' end,
 (q.created_at at time zone 'America/Sao_Paulo')::date,null,'{}'::jsonb,q.project,array[r.owner_id,r.technician_id],array[q.state] from ssma_epi.requests q join ssma_epi.regions r on r.id=q.region_id
 )
 select jsonb_build_object('people',(select jsonb_agg(jsonb_build_object('id',user_id,'name',display_name,'master',is_master,'permissions',permissions) order by display_name) from public.ssma_profiles),
 'rows',coalesce((select jsonb_agg(to_jsonb(x)) from rows x),'[]'),'projects',coalesce((select jsonb_agg(to_jsonb(v) order by state,project) from projects v),'[]')) into result;
 return result;
end $$;
create function public.ssma_master(action text,p jsonb) returns jsonb language sql security invoker set search_path='' as $$select ssma_epi.master(action,p)$$;
revoke all on function ssma_epi.allowed(text),ssma_epi.manage(text,jsonb),ssma_epi.workspace(),ssma_epi.dashboard(),ssma_epi.master(text,jsonb),public.ssma_master(text,jsonb) from public,anon,authenticated;
grant execute on function ssma_epi.allowed(text),ssma_epi.manage(text,jsonb),ssma_epi.workspace(),ssma_epi.dashboard(),ssma_epi.master(text,jsonb),public.ssma_master(text,jsonb) to authenticated;
