-- Atualiza somente a origem dos vínculos atuais no resumo Master.
do $migration$
declare
 definition text := pg_get_functiondef('ssma_epi.master(text,jsonb)'::regprocedure);
 old_projects text := $old$ select distinct who.tech, x.unit as project, coalesce(uf.state,'Sem UF informada') as state
 from rows x cross join lateral unnest(x.techs) who(tech) cross join lateral unnest(x.states) uf(state)
 join public.ssma_profiles t on t.user_id=who.tech
 where trim(x.unit)<>'' and (t.is_master or uf.state is null or uf.state=any(t.coverage))
 union select a.tech,a.project,a.state from assigned a join public.ssma_profiles t on t.user_id=a.tech
 where t.active and (t.is_master or a.state=any(t.coverage))$old$;
 new_projects text := $new$ select distinct t.user_id as tech, trim(e.unit) as project,
   coalesce(nullif(trim(e.employee_state),''),substring(upper(trim(e.unit)) from '/\s*([A-Z]{2})$'),'Sem UF informada') as state
 from public.ssma_records e
 left join public.ssma_profiles t on t.active and not t.is_master and t.removed_at is null
   and t.user_id::text=coalesce(nullif(e.details->>'technicianId',''),e.owner_id::text)
 where e.module='colaboradores' and trim(e.unit)<>''$new$;
begin
 if strpos(definition,old_projects)=0 then raise exception 'Consulta de projetos incompatível.'; end if;
 execute replace(definition,old_projects,new_projects);
end $migration$;
