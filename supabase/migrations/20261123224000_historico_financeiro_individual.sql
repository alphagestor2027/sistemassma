-- Garante independência total entre a aba Financeiro e a aba Histórico de movimentações
ALTER TABLE ssma_epi.movements ADD COLUMN IF NOT EXISTS history_cleared_at timestamptz;
CREATE INDEX IF NOT EXISTS epi_movements_history_cleared ON ssma_epi.movements(history_cleared_at);

-- Migra o cleared_at antigo (que limpou indevidamente o financeiro) para history_cleared_at,
-- e zera cleared_at para restaurar as "Entradas de material" e "Saídas por entrega" no Financeiro:
UPDATE ssma_epi.movements SET history_cleared_at = COALESCE(history_cleared_at, cleared_at) WHERE cleared_at IS NOT NULL;
UPDATE ssma_epi.movements SET cleared_at = NULL;

-- Atualiza workspace_owned:
-- A aba Financeiro recebe todas as movimentações ativas (Entrada e Saída).
-- O histórico limpo afeta APENAS a aba "Histórico de movimentações".
CREATE OR REPLACE FUNCTION ssma_epi.workspace_owned() RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
 with regions as (
 select r.*, p.display_name technician, p.username technician_login from ssma_epi.regions r
 join public.ssma_profiles p on p.user_id=r.technician_id where ssma_epi.can_use_stock(r)
 ), materials as (
 select m.*, certificate.ca_expiry from ssma_epi.materials m
 left join lateral (
   select coalesce(to_char(v.expiry,'DD/MM/YYYY'),nullif(f.sheet->>'validade','')) as ca_expiry
   from ssma_epi.ca_catalog c cross join lateral jsonb_array_elements(c.fichas) with ordinality f(sheet,pos)
   left join ssma_epi.ca_expiry_changes v on v.ca=c.ca and v.sheet_key=md5(f.sheet::text)
   where not m.no_ca and c.ca=ltrim(trim(m.ca),'0')
   order by (m.ca_sheet_key=md5(f.sheet::text)) desc nulls last,f.pos limit 1
 ) certificate on true where m.archived_at is null and ((m.region_id is null and (exists(select 1 from public.ssma_profiles t where t.user_id=auth.uid() and t.active and t.is_master))) or m.region_id in(select id from regions))
 ), requests as (
 select q.*, registered.id is null as employee_removed,
   false as finance_cleared,
   coalesce((select jsonb_agg(to_jsonb(l) order by l.name,l.material_id) from ssma_epi.lines l where l.request_id=q.id),'[]') items
 from ssma_epi.requests q left join public.ssma_records registered on registered.id=q.employee_id and registered.module='colaboradores' where q.region_id in(select id from regions) and ssma_epi.request_in_area(q.employee_id,q.state)
 ), assets as (
 select a.*, coalesce((select jsonb_agg(to_jsonb(t) order by t.id desc) from ssma_epi.tests t where t.asset_id=a.id),'[]') history
 from ssma_epi.assets a where a.request_id in(select id from requests)
 )
 select jsonb_build_object(
 'regions',coalesce((select jsonb_agg(to_jsonb(r) order by r.state,r.name) from regions r),'[]'),
 'assignments',coalesce((select jsonb_agg(to_jsonb(a)||jsonb_build_object('active',e.status='Ativo','employee',e.title)) from ssma_epi.assignments a join public.ssma_records e on e.id=a.employee_id where a.region_id in(select id from regions) and ssma_epi.request_in_area(a.employee_id,a.state)),'[]'),
 'materials',coalesce((select jsonb_agg(to_jsonb(m) order by m.name,m.size,m.color) from materials m),'[]'),
 'requests',coalesce((select jsonb_agg((to_jsonb(q) || case when q.employee_removed then jsonb_build_object('employee','Colaborador removido') else '{}'::jsonb end) order by q.created_at desc) from requests q),'[]'),
 'movements',coalesce((select jsonb_agg(to_jsonb(v) order by v.created_at desc) from ssma_epi.movements v where ((v.region_id is null and exists(select 1 from public.ssma_profiles t where t.user_id=auth.uid() and t.is_master and t.active)) or v.region_id in(select id from regions)) and (v.request_id is null or v.request_id in(select id from requests))),'[]'),
 'rules',coalesce((select jsonb_agg(to_jsonb(s)) from ssma_epi.rules s where s.material_id in(select id from materials)),'[]'),
 'assets',coalesce((select jsonb_agg(to_jsonb(a) order by a.due) from assets a),'[]')
 ) where exists(select 1 from public.ssma_profiles where user_id=auth.uid());
$function$;

-- Atualiza ssma_epi_stock_costs para não excluir saídas por causa de limpeza de histórico:
CREATE OR REPLACE FUNCTION public.ssma_epi_stock_costs() RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
 select coalesce(jsonb_agg(to_jsonb(z) order by project,state,material),'[]') from (
   select q.project,q.state,l.ca,min(l.name) as material,
     sum(l.qty)::int qty,sum(l.price*l.qty) as cost
   from ssma_epi.requests q join ssma_epi.regions r on r.id=q.region_id join ssma_epi.lines l on l.request_id=q.id
   where ssma_epi.allowed('epi.estoque') and ssma_epi.can_use_stock(r) and ssma_epi.request_in_area(q.employee_id,q.state)
     and q.status='Entregue' and q.destination='Projeto'
   group by q.project,q.state,l.ca,case when trim(l.ca)='' then l.name end
 ) z
$function$;

-- Atualiza ssma_epi.manage: clear_history e history operam em history_cleared_at:
CREATE OR REPLACE FUNCTION ssma_epi.manage(action text, p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare result jsonb; k text; project text:=lower(trim(p->>'project')); dest uuid; actor public.ssma_profiles; responsible uuid;
begin
 if action in ('stock_technicians','material','allocate','edit_material') then
   if not ssma_epi.allowed('epi.estoque') then raise exception 'Sem permissão de estoque.'; end if;
   select * into strict actor from public.ssma_profiles where user_id=auth.uid() and active for share;
   if action='stock_technicians' then
     if not actor.is_master then raise exception 'Acesso exclusivo do Master.'; end if;
     return (select coalesce(jsonb_agg(jsonb_build_object('id',t.user_id,'name',t.display_name) order by t.display_name,t.user_id),'[]') from public.ssma_profiles t
       where t.active and not t.is_master and 'epi.estoque'=any(t.permissions));
   end if;
   if action='edit_material' then
     select m.region_id into dest from ssma_epi.materials m where m.id=(p->>'material_id')::uuid and m.archived_at is null for update;
     if not found then raise exception 'Material indisponível.'; end if;
   end if;
   if dest is null then
     responsible:=nullif(p->>'technician_id','')::uuid;
     if actor.is_master then
       if responsible is null then
         select min(t.user_id::text)::uuid into responsible from public.ssma_profiles t where t.active and not t.is_master and 'epi.estoque'=any(t.permissions) having count(*)=1;
       end if;
       select coalesce(t.stock_unit,t.user_id) into dest from public.ssma_profiles t where t.user_id=responsible and t.active and not t.is_master and 'epi.estoque'=any(t.permissions) for share;
     else
       if responsible is not null and responsible<>actor.user_id then raise exception 'O material deve usar o estoque do seu cadastro.'; end if;
       responsible:=actor.user_id;
       dest:=coalesce(actor.stock_unit,responsible);
     end if;
     if dest is null then raise exception 'Selecione um técnico ativo com permissão de estoque no Painel Master.'; end if;
     if dest=responsible then
       insert into ssma_epi.regions(id,owner_id,technician_id,name,individual)
       select t.user_id,t.user_id,t.user_id,'Estoque de '||t.display_name,true from public.ssma_profiles t where t.user_id=responsible
       on conflict(id) do nothing;
       if not exists(select 1 from ssma_epi.regions where id=dest and individual) then raise exception 'Identificador de estoque indisponível.'; end if;
     end if;
   end if;
   if nullif(p->>'region_id','')::uuid is not null and (p->>'region_id')::uuid<>dest then raise exception 'O estoque informado difere do cadastro. Reabra o material.'; end if;
   p:=jsonb_set(p,'{region_id}',to_jsonb(dest));
 end if;
 if action='clear_history' then
   if not ssma_epi.allowed('epi.historico') then
     raise exception 'Sem permissão para limpar o histórico.' using errcode='42501';
   end if;
   with cleared as (
     update ssma_epi.movements v set history_cleared_at=statement_timestamp()
     where v.history_cleared_at is null and (
       exists(select 1 from public.ssma_profiles t where t.user_id=auth.uid() and t.active and t.is_master)
       or (exists(select 1 from ssma_epi.regions r where r.id=v.region_id and ssma_epi.can_use_stock(r))
         and (v.request_id is null or exists(select 1 from ssma_epi.requests q where q.id=v.request_id and ssma_epi.request_in_area(q.employee_id,q.state)))))
     returning 1
   ) select jsonb_build_object('count',count(*)) into result from cleared;
   return result;
 end if;
 if action='history' then
   if not ssma_epi.allowed('epi.historico') then raise exception 'Sem acesso ao histórico.'; end if;
   if nullif(p->>'start','')::date is null or nullif(p->>'end','')::date is null or (p->>'start')::date>(p->>'end')::date then raise exception 'Informe um período válido.'; end if;
   return (select coalesce(jsonb_agg(to_jsonb(h) order by h.created_at desc,h.id),'[]') from (
     select v.id,v.created_at,v.kind,v.qty,v.material_label,r.name as unit,q.project,case when q.id is not null and registered.id is null then 'Colaborador removido' else q.employee end as employee,
       case when ssma_epi.allowed('epi.financeiro') then v.price*v.qty end as total
     from ssma_epi.movements v left join ssma_epi.regions r on r.id=v.region_id left join ssma_epi.requests q on q.id=v.request_id
     left join public.ssma_records registered on registered.id=q.employee_id and registered.module='colaboradores'
     where v.history_cleared_at is null and ssma_epi.can_use_stock(r) and (q.id is null or ssma_epi.request_in_area(q.employee_id,q.state))
       and v.created_at>=((p->>'start')::date::timestamp at time zone 'America/Sao_Paulo')
       and v.created_at<(((p->>'end')::date+1)::timestamp at time zone 'America/Sao_Paulo')
   ) h);
 end if;
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
 when action='rule' then 'compras' when action in('asset','test') then 'ensaios' end;
 if k is null or not ssma_epi.allowed('epi.'||k) then raise exception 'Sem permissão para esta operação.'; end if;
 if action in ('progress','deliver','cancel','asset','test') and not exists(select 1 from ssma_epi.requests q where q.id=case when action='test' then (select a.request_id from ssma_epi.assets a where a.id=(p->>'asset_id')::uuid) else (p->>'request_id')::uuid end and ssma_epi.request_in_area(q.employee_id,q.state)) then raise exception 'Pedido fora da área de atendimento.'; end if;
 if action in ('progress','deliver') then
   perform 1 from public.ssma_records e join ssma_epi.requests q on q.employee_id=e.id
     where q.id=(p->>'request_id')::uuid and e.module='colaboradores' for share of e;
   if not found then raise exception 'Cadastro removido. Cancele a solicitação para liberar o estoque.'; end if;
 end if;
 if action='rule' then
   perform 1 from ssma_epi.materials where id=(p->>'material_id')::uuid and archived_at is null for share;
   if not found then raise exception 'Material indisponível.'; end if;
 end if;
 return ssma_epi.manage_owned(action,p);
end $function$;
