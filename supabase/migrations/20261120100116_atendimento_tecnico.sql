create function ssma_epi.service_areas() returns jsonb language sql immutable set search_path='' as $$
 select '{"Norte":["AC","AP","AM","PA","RO","RR","TO"],"Nordeste":["AL","BA","CE","MA","PB","PE","PI","RN","SE"],"Centro-Oeste":["DF","GO","MT","MS"],"Sudeste":["ES","MG","RJ","SP"],"Sul":["PR","RS","SC"]}'::jsonb
$$;
revoke all on function ssma_epi.service_areas() from public, anon, authenticated;

alter table public.ssma_profiles
 add column service_region text not null default '',
 add column service_state text not null default '',
 add constraint valid_service_area check (
 (service_region='' and service_state='') or
 (ssma_epi.service_areas() ? service_region and
 (service_state='' or (ssma_epi.service_areas()->service_region) ? service_state))
 );

create or replace function ssma_epi.on_technician_created() returns trigger language plpgsql security definer set search_path='' as $$
declare info jsonb:=new.raw_app_meta_data->'ssma_technician'; login text:=split_part(new.email,'@',1);
begin
 if info is null then return new; end if;
 if tg_op='UPDATE' and old.raw_app_meta_data->'ssma_technician' is not null then return new; end if;
 if not exists(select 1 from public.ssma_profiles where user_id=(info->>'created_by')::uuid and is_master and active)
 or login!~'^[a-z0-9][a-z0-9._-]{2,39}$' or login='cesar' or new.email<>login||'@ssma.invalid'
 or nullif(trim(info->>'name'),'') is null or length(trim(info->>'name'))>120 then raise exception 'Cadastro de técnico inválido.'; end if;
 insert into public.ssma_profiles(user_id,username,display_name,service_region,service_state)
 values(new.id,login,trim(info->>'name'),coalesce(info->>'service_region',''),coalesce(info->>'service_state',''));
 return new;
end $$;

create or replace function ssma_epi.master(action text,p jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
 if not exists(select 1 from public.ssma_profiles where user_id=auth.uid() and is_master and active) then raise exception 'Acesso exclusivo do Master.'; end if;
 if action='authorize_creation' then return to_jsonb(auth.uid()); end if;
 if action='edit_technician' then
 if nullif(trim(p->>'name'),'') is null or length(trim(p->>'name'))>120 then raise exception 'Informe um nome de até 120 caracteres.'; end if;
 update public.ssma_profiles set display_name=trim(p->>'name'),active=(p->>'active')::boolean,
 service_region=coalesce(p->>'service_region',service_region),service_state=coalesce(p->>'service_state',service_state)
 where user_id=(p->>'technician')::uuid and not is_master and display_name=p->>'previous_name' and active=(p->>'previous_active')::boolean
 and (not (p ? 'service_region' or p ? 'service_state') or (service_region=p->>'previous_region' and service_state=p->>'previous_state'));
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
 select jsonb_build_object('service_areas',ssma_epi.service_areas(),'people',(select jsonb_agg(jsonb_build_object('id',user_id,'name',display_name,'master',is_master,'username',username,'service_region',service_region,'service_state',service_state,'active',active,'permissions',permissions) order by display_name) from public.ssma_profiles),
 'rows',coalesce((select jsonb_agg(to_jsonb(x)) from rows x),'[]'),'projects',coalesce((select jsonb_agg(to_jsonb(v) order by state,project) from projects v),'[]')) into result;
 return result;
end $$;
