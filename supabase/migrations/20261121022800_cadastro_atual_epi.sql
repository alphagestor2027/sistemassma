create or replace function ssma_epi.can_use_stock(r ssma_epi.regions) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.ssma_profiles t where t.user_id=auth.uid() and t.active and (t.is_master or t.stock_unit=r.id or (t.stock_unit is null and r.individual and r.id=t.user_id)))
$$;

create or replace function ssma_epi.sheet(action text,p jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
 emp uuid := (p->>'employee_id')::uuid;
 actor uuid := auth.uid();
 master boolean;
 e public.ssma_records;
 doc ssma_epi.sheets;
 snap jsonb; opts jsonb; list jsonb; template jsonb; items jsonb; org text;
begin
 if not ssma_epi.allowed('epi.ficha') then raise exception 'Sem acesso à ficha digital.' using errcode='42501'; end if;
 select is_master into master from public.ssma_profiles where user_id=actor;
 if action='expiring' then
   return (select coalesce(jsonb_agg(jsonb_build_object('number',s.number,'employee',s.snapshot->>'name','expires_at',s.expires_at) order by s.expires_at),'[]')
     from ssma_epi.sheets s where s.expires_at between now() and now()+interval '72 hours'
     and (master or (s.author=actor and exists(select 1 from public.ssma_records worker where worker.id=s.employee_id and ssma_epi.record_area(worker))
       and not exists(select 1 from jsonb_array_elements(s.snapshot->'items') i where not exists(select 1 from ssma_epi.regions r where r.id=(i->>'region_id')::uuid and ssma_epi.can_use_stock(r) and ssma_epi.request_in_area(s.employee_id,i->>'state'))))));
 end if;
 if action='archived' then
   return (select coalesce(jsonb_agg(jsonb_build_object('id',s.id,'employee_id',s.employee_id,'number',s.number,'issued_at',s.issued_at) order by s.number desc),'[]')
     from ssma_epi.sheets s where master and s.expires_at>now() and not exists(select 1 from public.ssma_records e1 where e1.id=s.employee_id));
 end if;
 if action='employees' then
   return (select coalesce(jsonb_agg(jsonb_build_object('id',e1.id,'name',e1.title) order by e1.title,e1.id),'[]')
     from public.ssma_records e1 where e1.module='colaboradores' and ssma_epi.record_area(e1));
 end if;
 select x.* into e from public.ssma_records x where x.id=emp and x.module='colaboradores' and ssma_epi.record_area(x) for share;
 if e.id is null and not (master and action in ('open','edit','delete') and exists(
   select 1 from ssma_epi.sheets s where s.id=(p->>'id')::uuid and s.employee_id=emp and s.expires_at>now())) then
   raise exception 'Colaborador fora da área de atendimento.' using errcode='42501';
 end if;
 if action='issue' then
   perform pg_advisory_xact_lock(hashtextextended(p->>'id',0));
   select * into doc from ssma_epi.sheets where id=(p->>'id')::uuid;
   if found then
     if doc.employee_id=emp and doc.author=actor and doc.issue_hash=md5(p::text) then return ssma_epi.sheet('open',p); end if;
     raise exception 'Identificador de ficha já utilizado.';
   end if;
 end if;
 if action in ('open','edit','delete') then
   select s.* into doc from ssma_epi.sheets s where s.id=(p->>'id')::uuid and s.employee_id=emp
    and (master or (s.author=actor and not exists(
      select 1 from jsonb_array_elements(s.snapshot->'items') i
      where not exists(select 1 from ssma_epi.regions r where r.id=(i->>'region_id')::uuid
        and ssma_epi.can_use_stock(r) and ssma_epi.request_in_area(emp,i->>'state'))))) for update;
   if doc.id is null then raise exception 'Ficha indisponível.'; end if;
   if action='open' then return to_jsonb(doc); end if;
   if doc.revision is distinct from (p->>'revision')::int then raise exception 'A ficha foi alterada. Abra a versão atual.'; end if;
   if action='delete' then delete from ssma_epi.sheets where id=doc.id; return jsonb_build_object('ok',true); end if;
   snap:=doc.snapshot;
 elsif action in ('context','issue') then
   select coalesce(jsonb_agg(jsonb_build_object('key',q.id::text||'/'||l.material_id::text,'date',(q.closed_at at time zone 'America/Sao_Paulo')::date,
     'reason',l.reason,'ca',l.ca,'equipment',concat_ws(' · ',l.name,nullif(l.size,''),nullif(l.color,'')),'qty',l.qty,
     'state',q.state,'region_id',q.region_id,'employee',q.employee,'project',q.project,'job',q.job) order by q.closed_at,q.id,l.name,l.material_id),'[]') into items
   from ssma_epi.requests q join ssma_epi.lines l on l.request_id=q.id join ssma_epi.regions r on r.id=q.region_id
   where q.employee_id=emp and q.status='Entregue' and ssma_epi.can_use_stock(r) and ssma_epi.request_in_area(emp,q.state);
   snap:=jsonb_build_object('name',coalesce(e.title,items->-1->>'employee'),'unit',coalesce(e.unit,items->-1->>'project'),
     'job',coalesce(e.details->>'extra',items->-1->>'job'),'company',e.details->>'company','sector',e.details->>'sector',
     'cnpj',e.details->>'cnpj','registration',e.details->>'registration','cpf',e.details->>'cpf','items',items);
 else raise exception 'Operação inválida.'; end if;
 org:=coalesce(nullif(upper(regexp_replace(snap->>'cnpj','[^a-zA-Z0-9]','','g')),''),nullif(lower(trim(snap->>'company')),''));
 if action='context' then
   select coalesce(jsonb_agg(jsonb_build_object('id',s.id,'number',s.number,'issued_at',s.issued_at) order by s.number desc),'[]') into list
     from ssma_epi.sheets s where s.employee_id=emp and (master or (s.author=actor and not exists(
      select 1 from jsonb_array_elements(s.snapshot->'items') i where not exists(select 1 from ssma_epi.regions r where r.id=(i->>'region_id')::uuid
      and ssma_epi.can_use_stock(r) and ssma_epi.request_in_area(emp,i->>'state')))));
   select settings into template from ssma_epi.sheet_templates where company_key=org;
   return jsonb_build_object('snapshot',snap,'version',md5(snap::text),'sheets',list,'template',template,'materials',(select coalesce(jsonb_agg(jsonb_build_object('id',m.id,'name',concat_ws(' · ',m.name,nullif(m.size,''),nullif(m.color,'')),'available',m.qty-m.reserved) order by m.name,m.size,m.id),'[]') from ssma_epi.materials m join ssma_epi.regions r on r.id=m.region_id where e.status='Ativo' and m.region_id=ssma_epi.employee_unit(e) and exists(select 1 from ssma_epi.assignments a where a.employee_id=e.id and a.state=e.employee_state and a.region_id=r.id) and ssma_epi.can_use_stock(r) and m.archived_at is null and m.qty>m.reserved and (m.expiry is null or m.expiry>=(now() at time zone 'America/Sao_Paulo')::date) and (not m.insulating_glove or (now() at time zone 'America/Sao_Paulo')::date between m.glove_start and m.glove_start+365)));
 end if;
 if action='issue' and md5(snap::text) is distinct from p->>'version' then raise exception 'As entregas ou o cadastro mudaram. Reabra a prévia.'; end if;
 opts:=p->'settings';
 if action='issue' and jsonb_array_length(coalesce(p->'new_items','[]'))>0 then
   perform ssma_epi.sheet_delivery(e,(p->>'id')::uuid,p->'new_items');
   snap:=ssma_epi.sheet('context',p)->'snapshot';
   opts:=jsonb_set(opts,'{identity,unit}',to_jsonb(e.unit));
   opts:=jsonb_set(opts,'{reasons}',(opts->'reasons') || (select jsonb_object_agg((p->>'id')||'/'||l.material_id,l.reason) from ssma_epi.lines l where l.request_id=(p->>'id')::uuid));
 end if;
 if action='edit' and exists(select 1 from ssma_epi.requests q where q.id=doc.id) then
   opts:=jsonb_set(opts,'{identity,unit}',snap->'unit');
 end if;
 if jsonb_typeof(opts) is distinct from 'object' or jsonb_typeof(opts->'legal') is distinct from 'string'
    or jsonb_typeof(opts->'term') is distinct from 'string' or jsonb_typeof(opts->'place') is distinct from 'string'
    or length(opts->>'place')>200 or jsonb_typeof(opts->'logo') is distinct from 'string' or length(coalesce(opts->>'legal','')) not between 1 and 20000
    or length(coalesce(opts->>'term','')) not between 1 and 20000 or octet_length(opts::text)>600000
    or jsonb_typeof(opts->'reasons') is distinct from 'object'
    or (coalesce(opts->>'logo','')<>'' and (length(opts->>'logo')>350000 or opts->>'logo' !~ '^data:image/png;base64,iVBORw0KGgo[A-Za-z0-9+/=]+$')) then
    raise exception 'Confira os textos, o tamanho da logo e os motivos da ficha.'; end if;
 if jsonb_typeof(opts->'identity') is distinct from 'object' or
    exists(select 1 from jsonb_each(opts->'identity') f where jsonb_typeof(f.value)<>'string' or length(f.value#>>'{}')>254) or
    coalesce(length(trim(opts->'identity'->>'name')),0)=0 or
    exists(select 1 from jsonb_each(opts->'reasons') reason where jsonb_typeof(reason.value)<>'string' or length(reason.value#>>'{}')>300
      or not exists(select 1 from jsonb_array_elements(snap->'items') item where item->>'key'=reason.key)) then
    raise exception 'Confira a identificação do colaborador e os motivos de entrega.';
 end if;
 if action='issue' then
   insert into ssma_epi.sheets(id,employee_id,author,snapshot,settings,issue_hash) values((p->>'id')::uuid,emp,actor,snap,opts,md5(p::text))
   on conflict(id) do nothing returning * into doc;
   if not found then
     select * into doc from ssma_epi.sheets where id=(p->>'id')::uuid and author=actor and employee_id=emp and snapshot=snap and settings=opts;
     if not found then raise exception 'Identificador de ficha já utilizado.'; end if;
   end if;
 else
   update ssma_epi.sheets set settings=opts,revision=revision+1 where id=doc.id returning * into doc;
 end if;
 if (p->>'save_template')::boolean then
   if not master or org is null then raise exception 'Para salvar o modelo, informe a empresa ou CNPJ no cadastro e use o acesso Master.'; end if;
   insert into ssma_epi.sheet_templates values(org,jsonb_build_object('legal',opts->>'legal','term',opts->>'term','logo',opts->>'logo'))
   on conflict(company_key) do update set settings=excluded.settings;
 end if;
 return to_jsonb(doc);
end $$;

create or replace function ssma_epi.portal(action text, p jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare
 emp public.ssma_records; a ssma_epi.assignments; r ssma_epi.regions; tech text;
 mat ssma_epi.materials; item record; result jsonb; req_id uuid; inserted uuid;
begin
 if action='track' then
 select jsonb_build_object('stage',case when q.status='Solicitado' then q.stage else q.status end,'postal',q.postal,
 'events',jsonb_build_array(jsonb_build_object('stage','Pedido recebido','date',q.created_at)) || q.events ||
 case when q.closed_at is null then '[]'::jsonb else jsonb_build_array(jsonb_build_object('stage',q.status,'date',q.closed_at)) end)
 into result from ssma_epi.requests q where q.tracking_code=upper(trim(p->>'code'));
 if result is null then raise exception 'Pedido não encontrado. Confira o código de rastreio.'; end if;
 return result;
 end if;
 if action='track_name' then
   if length(trim(p->>'name'))<2 or nullif(trim(p->>'name'),'') is null then raise exception 'Digite o nome completo.'; end if;
   return (select coalesce(jsonb_agg(to_jsonb(z) order by z.name,z.project,z.id),'[]') from (
     select e.id,e.title name,e.unit project from public.ssma_records e where e.module='colaboradores' and lower(trim(e.title))=lower(trim(p->>'name'))
   ) z);
 end if;
 if action='track_employee' then
   return (select coalesce(jsonb_agg(jsonb_build_object('date',q.created_at,'project',q.project,'status',case when q.status='Solicitado' then q.stage else q.status end,'postal',q.postal)
     order by q.created_at desc,q.id),'[]') from ssma_epi.requests q where q.employee_id=(p->>'employee_id')::uuid and exists(select 1 from public.ssma_records e where e.id=q.employee_id and lower(trim(e.title))=lower(trim(p->>'name')) and e.module='colaboradores'));
 end if;
 if action='names' then
 select coalesce(jsonb_agg(jsonb_build_object('id',e.id,'name',e.title,'project',e.unit) order by e.title,e.id),'[]') into result
 from public.ssma_records e where e.module='colaboradores' and e.status='Ativo'
 ;
 return result;
 end if;
 select * into emp from public.ssma_records e where e.id=(p->>'employee_id')::uuid and e.module='colaboradores' and e.status='Ativo' for share;
 if emp.id is null then raise exception 'Colaborador indisponível.'; end if;
 if action='states' then return (select coalesce(jsonb_agg(v.state order by v.state),'[]') from ssma_epi.assignments v where v.employee_id=emp.id); end if;
 if action='submit' then
   perform 1 from public.ssma_profiles t where t.user_id::text=coalesce(nullif(emp.details->>'technicianId',''),emp.owner_id::text) for share;
 end if;
 perform 1 from ssma_epi.project_units where project_key=lower(trim(emp.unit)) for share;
 select * into a from ssma_epi.assignments where employee_id=emp.id and
 (state=coalesce(nullif(p->>'state',''),emp.employee_state) or (emp.employee_state is null and not (p ? 'state') and 1=(select count(*) from ssma_epi.assignments where employee_id=emp.id)));
 if a.region_id is null and action<>'context' then raise exception 'Vínculo com a regional não encontrado.'; end if;
 select * into r from ssma_epi.regions where id=a.region_id and (distribution_unit is not null or (individual and id=ssma_epi.employee_unit(emp)) or owner_id=emp.owner_id) for share;
 select display_name into tech from public.ssma_profiles t where t.active and coalesce(t.stock_unit,t.user_id)=r.id and a.state=any(t.coverage)
 order by (t.user_id::text=emp.details->>'technicianId') desc nulls last,t.display_name,t.user_id limit 1;
 select coalesce((select display_name from public.ssma_profiles where user_id::text=emp.details->>'technicianId' and active),tech,'A definir') into tech;
 if action='context' then
 return jsonb_build_object('project',emp.unit,'job',coalesce(a.job,emp.details->>'extra'),'technician',tech,
 'management',emp.details->>'management','coordinator',emp.details->>'coordinator','registration',nullif(trim(emp.details->>'registration'),''),
 'cpf_masked',case when nullif(trim(emp.details->>'registration'),'') is null and length(regexp_replace(emp.details->>'cpf','[^0-9]','','g'))=11 then '***.***.***-'||right(regexp_replace(emp.details->>'cpf','[^0-9]','','g'),2) end,
 'area',coalesce(nullif(emp.details->>'region',''),(select key from jsonb_each(ssma_epi.service_areas()) where value ? coalesce(emp.employee_state,a.state))),
 'materials',(select coalesce(jsonb_agg(jsonb_build_object('id',m.id,'name',m.name,'ca',m.ca,'size',m.size,'color',m.color,'available',m.qty-m.reserved) order by m.name,m.size),'[]')
 from ssma_epi.materials m where m.region_id=r.id and m.archived_at is null and (not m.insulating_glove or m.glove_start <= (now() at time zone 'America/Sao_Paulo')::date) and m.qty>m.reserved and (m.expiry is null or m.expiry>=(now() at time zone 'America/Sao_Paulo')::date)),
 'history',(select coalesce(jsonb_agg(jsonb_build_object('date',q.created_at,'closed_at',q.closed_at,'status',case when q.status='Solicitado' then q.stage else q.status end,'state',q.state,'project',q.project,
 'items',(select jsonb_agg(jsonb_build_object('name',l.name,'size',l.size,'color',l.color,'qty',l.qty) order by l.name) from ssma_epi.lines l where l.request_id=q.id)) order by q.created_at desc),'[]')
 from ssma_epi.requests q where q.employee_id=emp.id));
 end if;
 if action<>'submit' or action is null then raise exception 'Operação desconhecida.'; end if;
 if jsonb_typeof(p->'items') is distinct from 'array' or jsonb_array_length(p->'items') not between 1 and 100 then raise exception 'Selecione de 1 a 100 materiais.'; end if;
 req_id:=(p->>'id')::uuid;
 insert into ssma_epi.requests(id,owner_id,employee_id,region_id,employee,state,project,job,technician,center,contract)
 values(req_id,emp.owner_id,emp.id,r.id,emp.title,a.state,a.project,a.job,tech,a.center,a.contract)
 on conflict(id) do nothing returning id into inserted;
 if inserted is null then
 if exists(select 1 from ssma_epi.requests q where q.id=req_id and q.employee_id=emp.id and q.region_id=r.id)
 and (select jsonb_agg(jsonb_build_object('id',l.material_id,'qty',l.qty) order by l.material_id) from ssma_epi.lines l where l.request_id=req_id)
 = (select jsonb_agg(v order by v->>'id') from jsonb_array_elements(p->'items') v) then return (select to_jsonb(tracking_code) from ssma_epi.requests where id=req_id); end if;
 raise exception 'Identificador de solicitação já utilizado.';
 end if;
 for item in select * from jsonb_to_recordset(p->'items') as i(id uuid,qty integer) order by id loop
 select * into mat from ssma_epi.materials where id=item.id and region_id=r.id and archived_at is null and (not insulating_glove or glove_start <= (now() at time zone 'America/Sao_Paulo')::date) for update;
 if mat.id is null or item.qty is null or item.qty<=0 or item.qty>mat.qty-mat.reserved
 or mat.expiry<(now() at time zone 'America/Sao_Paulo')::date then raise exception 'Saldo insuficiente ou material indisponível. Atualize os materiais.'; end if;
 insert into ssma_epi.lines(request_id,material_id,name,ca,size,color,qty) values(req_id,mat.id,mat.name,mat.ca,mat.size,mat.color,item.qty);
 update ssma_epi.materials set reserved=reserved+item.qty where id=mat.id;
 end loop;
 return (select to_jsonb(tracking_code) from ssma_epi.requests where id=req_id);
end $$;

create or replace function ssma_epi.workspace_owned() returns jsonb language sql stable security definer set search_path='' as $$
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
 select q.*, registered.id is null as employee_removed, coalesce((select jsonb_agg(to_jsonb(l) order by l.name,l.material_id) from ssma_epi.lines l where l.request_id=q.id),'[]') items
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
$$;

create or replace function ssma_epi.manage(action text,p jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare k text; project text:=lower(trim(p->>'project')); dest uuid; actor public.ssma_profiles; responsible uuid;
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
 if action='history' then
   if not ssma_epi.allowed('epi.historico') then raise exception 'Sem acesso ao histórico.'; end if;
   if nullif(p->>'start','')::date is null or nullif(p->>'end','')::date is null or (p->>'start')::date>(p->>'end')::date then raise exception 'Informe um período válido.'; end if;
   return (select coalesce(jsonb_agg(to_jsonb(h) order by h.created_at desc,h.id),'[]') from (
     select v.id,v.created_at,v.kind,v.qty,v.material_label,r.name as unit,q.project,case when q.id is not null and registered.id is null then 'Colaborador removido' else q.employee end as employee,
       case when ssma_epi.allowed('epi.financeiro') then v.price*v.qty end as total
     from ssma_epi.movements v left join ssma_epi.regions r on r.id=v.region_id left join ssma_epi.requests q on q.id=v.request_id
     left join public.ssma_records registered on registered.id=q.employee_id and registered.module='colaboradores'
     where ssma_epi.can_use_stock(r) and (q.id is null or ssma_epi.request_in_area(q.employee_id,q.state))
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
end $$;
