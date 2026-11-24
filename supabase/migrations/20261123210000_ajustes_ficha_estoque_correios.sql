-- Ajustes na Ficha de EPI (Modo Rascunho, Reset de Colaborador e Estorno na Exclusão)
-- Ajustes na Limpeza de Histórico (Preservação da Aba Financeira)
-- Ajustes nos Correios (Destino do custo de envio para Projeto, Setor Facilities ou SSMA)

CREATE OR REPLACE FUNCTION ssma_epi.sheet(action text, p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
 emp uuid := (p->>'employee_id')::uuid;
 actor uuid := auth.uid();
 master boolean;
 source_id uuid := nullif(p->>'request_id','')::uuid;
 source ssma_epi.requests;
 draft_payload jsonb;
 kept jsonb; added jsonb; line jsonb; material ssma_epi.materials; qty integer;
 e public.ssma_records;
 doc ssma_epi.sheets;
 snap jsonb; opts jsonb; list jsonb; template jsonb; items jsonb; org text;
 req_line record;
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
 if source_id is not null and action in ('issue','context','draft') then
   select q.* into source from ssma_epi.requests q join ssma_epi.regions r on r.id=q.region_id
    where q.id=source_id and q.employee_id=emp and q.status<>'Cancelado' and ssma_epi.can_use_stock(r) and ssma_epi.request_in_area(emp,q.state) for update of q;
   if not found then raise exception 'Solicitação indisponível.'; end if;
   select payload into draft_payload from ssma_epi.sheet_drafts where request_id=source_id and employee_id=emp;
   select * into doc from ssma_epi.sheets where request_id=source_id;
   if found then
     return jsonb_build_object('issued',ssma_epi.sheet('open',jsonb_build_object('employee_id',emp,'id',doc.id)));
   end if;
 end if;
 if action='draft' and source.id is null then raise exception 'Selecione a solicitação.'; end if;
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
   if action='delete' then
     -- Restitui materiais ao estoque e remove movimentações de custo associadas
     for req_line in select * from ssma_epi.lines where request_id in (doc.id, doc.request_id) loop
       update ssma_epi.materials m set qty=m.qty+req_line.qty where m.id=req_line.material_id;
     end loop;
     delete from ssma_epi.movements where request_id in (doc.id, doc.request_id);
     delete from ssma_epi.lines where request_id in (doc.id, doc.request_id);
     delete from ssma_epi.requests where id in (doc.id, doc.request_id);
     delete from ssma_epi.sheets where id=doc.id;
     return jsonb_build_object('ok',true);
   end if;
   snap:=doc.snapshot;
 elsif action in ('context','issue','draft') then
   -- Para nova ficha manual, não carrega entregas anteriores; inicia com lista limpa
   if source_id is not null then
     select coalesce(jsonb_agg(jsonb_build_object('key',q.id::text||'/'||l.material_id::text,'date',(coalesce(q.closed_at,q.created_at) at time zone 'America/Sao_Paulo')::date,
       'reason',l.reason,'ca',l.ca,'equipment',concat_ws(' · ',l.name,nullif(l.size,''),nullif(l.color,'')),'qty',l.qty,
       'state',q.state,'region_id',q.region_id,'employee',q.employee,'project',q.project,'job',q.job) order by q.closed_at,q.id,l.name,l.material_id),'[]') into items
     from ssma_epi.requests q join ssma_epi.lines l on l.request_id=q.id join ssma_epi.regions r on r.id=q.region_id
     where q.employee_id=emp and q.id=source_id and ssma_epi.can_use_stock(r) and ssma_epi.request_in_area(emp,q.state);
   elsif action='issue' and nullif(p->>'id','') is not null and exists(select 1 from ssma_epi.lines where request_id=(p->>'id')::uuid) then
     select coalesce(jsonb_agg(jsonb_build_object('key',q.id::text||'/'||l.material_id::text,'date',(coalesce(q.closed_at,q.created_at) at time zone 'America/Sao_Paulo')::date,
       'reason',l.reason,'ca',l.ca,'equipment',concat_ws(' · ',l.name,nullif(l.size,''),nullif(l.color,'')),'qty',l.qty,
       'state',q.state,'region_id',q.region_id,'employee',q.employee,'project',q.project,'job',q.job) order by q.closed_at,q.id,l.name,l.material_id),'[]') into items
     from ssma_epi.requests q join ssma_epi.lines l on l.request_id=q.id join ssma_epi.regions r on r.id=q.region_id
     where q.employee_id=emp and q.id=(p->>'id')::uuid and ssma_epi.can_use_stock(r) and ssma_epi.request_in_area(emp,q.state);
   else
     items:='[]'::jsonb;
   end if;
   snap:=jsonb_build_object('name',e.title,'unit',e.unit,
     'job',e.details->>'extra','company',e.details->>'company','sector',e.details->>'sector',
     'cnpj',e.details->>'cnpj','registration',e.details->>'registration','cpf',e.details->>'cpf','items',items);
 else raise exception 'Operação inválida.'; end if;
 org:=coalesce(nullif(upper(regexp_replace(snap->>'cnpj','[^a-zA-Z0-9]','','g')),''),nullif(lower(trim(snap->>'company')),''));
 if action='context' then
   select coalesce(jsonb_agg(jsonb_build_object('id',s.id,'number',s.number,'issued_at',s.issued_at) order by s.number desc),'[]') into list
     from ssma_epi.sheets s where s.employee_id=emp and (master or (s.author=actor and not exists(
      select 1 from jsonb_array_elements(s.snapshot->'items') i where not exists(select 1 from ssma_epi.regions r where r.id=(i->>'region_id')::uuid
      and ssma_epi.can_use_stock(r) and ssma_epi.request_in_area(emp,i->>'state')))));
   select settings into template from ssma_epi.sheet_templates where company_key=org;
   return jsonb_build_object('draft',draft_payload,'snapshot',snap,'version',md5(snap::text||coalesce(draft_payload::text,'')),'sheets',list,'template',template,'materials',(select coalesce(jsonb_agg(jsonb_build_object('id',m.id,'ca',m.ca,'generic_cas',m.generic_cas,'name',concat_ws(' · ',m.name,nullif(m.size,''),nullif(m.color,'')),'available',m.qty-m.reserved) order by m.name,m.size,m.id),'[]') from ssma_epi.materials m join ssma_epi.regions r on r.id=m.region_id where e.status='Ativo' and m.region_id=ssma_epi.employee_unit(e) and exists(select 1 from ssma_epi.assignments a where a.employee_id=e.id and a.state=e.employee_state and a.region_id=r.id) and ssma_epi.can_use_stock(r) and m.archived_at is null and m.qty>m.reserved and (m.expiry is null or m.expiry>=(now() at time zone 'America/Sao_Paulo')::date) and (not m.insulating_glove or (now() at time zone 'America/Sao_Paulo')::date between m.glove_start and m.glove_start+365)));
 end if;
 if action in ('draft','issue') and md5(snap::text||coalesce(draft_payload::text,'')) is distinct from p->>'version' then raise exception 'As entregas ou o cadastro mudaram. Reabra a prévia.'; end if;
 opts:=p->'settings';
 if source_id is not null and jsonb_array_length(coalesce(p->'new_items','[]'))>0 then raise exception 'Use os itens da ficha vinculada.'; end if;
 if action='issue' and jsonb_array_length(coalesce(p->'new_items','[]'))>0 then
   perform ssma_epi.sheet_delivery(e,(p->>'id')::uuid,p->'new_items');
   select coalesce(jsonb_agg(jsonb_build_object('key',q.id::text||'/'||l.material_id::text,'date',(coalesce(q.closed_at,q.created_at) at time zone 'America/Sao_Paulo')::date,
     'reason',l.reason,'ca',l.ca,'equipment',concat_ws(' · ',l.name,nullif(l.size,''),nullif(l.color,'')),'qty',l.qty,
     'state',q.state,'region_id',q.region_id,'employee',q.employee,'project',q.project,'job',q.job) order by q.closed_at,q.id,l.name,l.material_id),'[]') into items
   from ssma_epi.requests q join ssma_epi.lines l on l.request_id=q.id join ssma_epi.regions r on r.id=q.region_id
   where q.employee_id=emp and q.id=(p->>'id')::uuid and ssma_epi.can_use_stock(r) and ssma_epi.request_in_area(emp,q.state);
   snap:=jsonb_set(snap,'{items}',items);
   opts:=jsonb_set(opts,'{identity,unit}',to_jsonb(e.unit));
   opts:=jsonb_set(opts,'{reasons}',(opts->'reasons') || (select jsonb_object_agg((p->>'id')||'/'||l.material_id,l.reason) from ssma_epi.lines l where l.request_id=(p->>'id')::uuid));
 end if;
 if action='edit' and exists(select 1 from ssma_epi.requests q where q.id=doc.id) then
   opts:=jsonb_set(opts,'{identity,unit}',snap->'unit');
 end if;
 if action='issue' and source.status='Solicitado' then
   for line in select to_jsonb(l) from ssma_epi.lines l where l.request_id=source_id order by l.material_id loop
     if coalesce(p->'removed','[]') ? (source_id::text||'/'||(line->>'material_id')) then
       update ssma_epi.materials set reserved=reserved-(line->>'qty')::int where id=(line->>'material_id')::uuid;
       delete from ssma_epi.lines where request_id=source_id and material_id=(line->>'material_id')::uuid;
     end if;
   end loop;
   for line in select value from jsonb_array_elements(coalesce(p->'document_items','[]')) order by value->>'id' loop
     qty:=(line->>'qty')::int;
     if qty is null or qty<1 or coalesce(line->>'reason','') not in ('Inicial','Substituição por perda ou roubo','Substituição por período de troca/desgaste') then raise exception 'Confira a quantidade e o motivo.'; end if;
     update ssma_epi.materials set reserved=reserved+qty_requested.n from (select (line->>'qty')::int n) qty_requested
       where id=(line->>'id')::uuid and region_id=source.region_id and archived_at is null and ssma_epi.materials.qty-reserved>=qty_requested.n returning ssma_epi.materials.* into material;
     if not found then raise exception 'Saldo insuficiente ou material indisponível.'; end if;
     insert into ssma_epi.lines(request_id,material_id,name,ca,size,color,qty,price,reason) values(source_id,material.id,material.name,material.ca,material.size,material.color,qty,material.price,line->>'reason')
       on conflict(request_id,material_id) do update set qty=ssma_epi.lines.qty+excluded.qty,reason=excluded.reason;
   end loop;
   if not exists(select 1 from ssma_epi.lines where request_id=source_id) then raise exception 'Inclua pelo menos um EPI.'; end if;
   perform ssma_epi.manage('deliver',jsonb_build_object('request_id',source_id));
   snap:=ssma_epi.sheet('context',p)->'snapshot';
   opts:=jsonb_set(opts,'{reasons}',(select coalesce(jsonb_object_agg(i->>'key',coalesce(opts->'reasons'->>(i->>'key'),i->>'reason','')),'{}') from jsonb_array_elements(snap->'items') i));
 elsif action='edit' or source_id is not null then
   select coalesce(jsonb_agg(i order by ord),'[]') into kept from jsonb_array_elements(snap->'items') with ordinality t(i,ord)
    where not (coalesce(p->'removed','[]') ? (i->>'key'));
   added:='[]';
   for line in select value from jsonb_array_elements(coalesce(p->'document_items','[]')) loop
     qty:=(line->>'qty')::integer;
     if qty is null or qty<1 or qty>1000000 then raise exception 'Quantidade inválida.'; end if;
     select m.* into material from ssma_epi.materials m join ssma_epi.regions r on r.id=m.region_id
       where m.id=(line->>'id')::uuid and m.archived_at is null and ssma_epi.can_use_stock(r)
       and m.region_id=coalesce(source.region_id,ssma_epi.employee_unit(e));
     if not found then raise exception 'Material indisponível nesta unidade.'; end if;
     added:=added||jsonb_build_array(jsonb_build_object('key',gen_random_uuid(),'ca',material.ca,'qty',qty,'equipment',concat_ws(' · ',material.name,nullif(material.size,''),nullif(material.color,'')),
       'date',(now() at time zone 'America/Sao_Paulo')::date,'state',e.employee_state,'region_id',material.region_id,'reason',line->>'reason'));
   end loop;
   snap:=jsonb_set(snap,'{items}',kept||added);
   opts:=jsonb_set(opts,'{reasons}',(select coalesce(jsonb_object_agg(i->>'key',coalesce(opts->'reasons'->>(i->>'key'),i->>'reason','')),'{}') from jsonb_array_elements(snap->'items') i));
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
 if action='draft' then
   insert into ssma_epi.sheet_drafts values(source_id,emp,jsonb_build_object('settings',p->'settings','removed',p->'removed','items',p->'document_items')) on conflict(request_id) do update set payload=excluded.payload,employee_id=excluded.employee_id;
   return ssma_epi.sheet('context',p);
 end if;
 if action='issue' then
   insert into ssma_epi.sheets(id,employee_id,author,snapshot,settings,issue_hash,request_id) values((p->>'id')::uuid,emp,actor,snap,opts,md5(p::text),source_id)
   on conflict(id) do nothing returning * into doc;
   if not found then
     select * into doc from ssma_epi.sheets where id=(p->>'id')::uuid and author=actor and employee_id=emp and snapshot=snap and settings=opts;
     if not found then raise exception 'Identificador de ficha já utilizado.'; end if;
   end if;
 else
   update ssma_epi.sheets set snapshot=snap,settings=opts,revision=revision+1 where id=doc.id returning * into doc;
 end if;
 if (p->>'save_template')::boolean then
   if not master or org is null then raise exception 'Para salvar o modelo, informe a empresa ou CNPJ no cadastro e use o acesso Master.'; end if;
   insert into ssma_epi.sheet_templates values(org,jsonb_build_object('legal',opts->>'legal','term',opts->>'term','logo',opts->>'logo'))
   on conflict(company_key) do update set settings=excluded.settings;
 end if;
 if source_id is not null then delete from ssma_epi.sheet_drafts where request_id=source_id; end if;
 return to_jsonb(doc);
end $function$;

-- Ajuste de limpeza de histórico (afeta apenas o histórico de movimentações, sem afetar o financeiro)
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
     update ssma_epi.movements v set cleared_at=statement_timestamp()
     where v.cleared_at is null and (
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
     where v.cleared_at is null and ssma_epi.can_use_stock(r) and (q.id is null or ssma_epi.request_in_area(q.employee_id,q.state))
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

-- Ajuste nos Correios (aceita o destino escolhido: Projeto do colaborador, Setor Facilities ou SSMA)
CREATE OR REPLACE FUNCTION public.ssma_epi_logistics(action text, p jsonb default '{}')
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
 actor public.ssma_profiles; dest uuid; item jsonb; m ssma_epi.materials; e public.ssma_records;
 doc ssma_epi.invoices; shipment ssma_epi.shipments; previous_items jsonb:='[]'; new_items jsonb:='[]';
 movement_stamp timestamptz; cleared timestamptz; delta record; new_qty int; new_value numeric;
 invoice_total numeric:=0; amount integer; cost numeric; label text; project text; uf text; mid uuid;
 invoice_cnpj text:=upper(regexp_replace(p->>'cnpj','[^A-Za-z0-9]','','g'));
begin
 select * into strict actor from public.ssma_profiles where user_id=auth.uid() and active;
 if action in ('shipments','ship','edit_ship','delete_ship') then
   if not ssma_epi.allowed('epi.correios') then raise insufficient_privilege; end if;
 elsif action in ('invoices','invoice','edit_invoice','delete_invoice') then
   if not ssma_epi.allowed('epi.financeiro') then raise insufficient_privilege; end if;
 else raise exception 'Operação desconhecida.'; end if;
 if action in ('invoices','shipments') then
   return jsonb_build_object('units',(select coalesce(jsonb_agg(jsonb_build_object('id',r.id,'name',coalesce(r.distribution_unit,r.name)) order by r.name),'[]') from ssma_epi.regions r where ssma_epi.can_use_stock(r)),
    'materials',case when action='invoices' then (select coalesce(jsonb_agg(jsonb_build_object('id',m1.id,'name',m1.name,'ca',m1.ca,'size',m1.size,'color',m1.color,'region_id',r.id) order by m1.name),'[]') from ssma_epi.materials m1 join ssma_epi.regions r on r.id=m1.region_id where m1.archived_at is null and ssma_epi.can_use_stock(r)) else '[]'::jsonb end,
    'employees',case when action='shipments' then (select coalesce(jsonb_agg(jsonb_build_object('id',x.id,'name',x.title,'project',x.unit,'state',x.employee_state,'unit',ssma_epi.employee_unit(x)) order by x.title),'[]') from public.ssma_records x where x.module='colaboradores' and x.status='Ativo' and ssma_epi.record_area(x)) else '[]'::jsonb end,
    'rows',case when action='invoices' then (select coalesce(jsonb_agg(to_jsonb(i)-'actor' order by i.issued desc,i.number),'[]') from ssma_epi.invoices i join ssma_epi.regions r on r.id=i.unit_id where ssma_epi.can_use_stock(r))
      else (select coalesce(jsonb_agg(to_jsonb(s)-'actor' order by s.sent desc,s.tracking),'[]') from ssma_epi.shipments s join ssma_epi.regions r on r.id=s.unit_id where ssma_epi.can_use_stock(r) and (actor.is_master or s.state=any(actor.coverage))) end);
 end if;
 dest:=case when actor.is_master then (p->>'unit_id')::uuid else coalesce(actor.stock_unit,actor.user_id) end;
 if not actor.is_master and actor.stock_unit is null then
   insert into ssma_epi.regions(id,owner_id,technician_id,name,individual) values(actor.user_id,actor.user_id,actor.user_id,'Estoque de '||actor.display_name,true) on conflict(id) do nothing;
 end if;
 if not exists(select 1 from ssma_epi.regions r where r.id=dest and ssma_epi.can_use_stock(r)) then raise exception 'Confira a unidade de estoque no Painel Master.'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p->>'id',0));
 if action in ('ship','edit_ship','delete_ship') then
   if action<>'ship' then
     select * into shipment from ssma_epi.shipments h where h.id=(p->>'id')::uuid and h.unit_id=dest and (actor.is_master or h.state=any(actor.coverage)) for update;
     if not found then raise exception 'Envio indisponível. Atualize a lista.'; end if;
     if action='edit_ship' and shipment.request_hash=md5(p::text) then return '{"ok":true}'; end if;
     if shipment.request_hash is distinct from p->>'previous' then raise exception 'O envio foi alterado. Atualize a lista antes de continuar.'; end if;
     if action='delete_ship' then delete from ssma_epi.shipments where id=shipment.id; return '{"ok":true}'; end if;
   end if;
   if exists(select 1 from ssma_epi.shipments h where h.id=(p->>'id')::uuid and h.actor=auth.uid() and unit_id=dest and h.request_hash=md5(p::text)) then return '{"ok":true}'; end if;
   if nullif(p->>'employee_id','') is not null then
     select * into strict e from public.ssma_records x where x.id=(p->>'employee_id')::uuid and x.module='colaboradores' and x.status='Ativo' and ssma_epi.record_area(x) and ssma_epi.employee_unit(x)=dest for share;
     label:=e.title;
     project:=coalesce(nullif(trim(p->>'project'),''),e.unit);
     uf:=e.employee_state;
   else
     label:=trim(p->>'recipient');
     project:=coalesce(nullif(trim(p->>'project'),''),'SSMA');
     uf:=p->>'state';
   end if;
   if not exists(select 1 from jsonb_each(ssma_epi.service_areas()) a where a.value ? uf)
      or not (actor.is_master or uf=any(actor.coverage)) then raise exception 'UF fora da área de atendimento.'; end if;
   if action='edit_ship' then
     update ssma_epi.shipments set sent=(p->>'date')::date,tracking=upper(trim(p->>'tracking')),employee_id=e.id,recipient=label,
       project=coalesce(nullif(trim(p->>'project'),''),case when e.id is null then trim(p->>'project') else e.unit end),
       state=uf,mode=p->>'mode',cost=(p->>'price')::numeric,request_hash=md5(p::text) where id=shipment.id;
   else
     insert into ssma_epi.shipments values((p->>'id')::uuid,dest,auth.uid(),(p->>'date')::date,upper(trim(p->>'tracking')),e.id,label,project,uf,p->>'mode',(p->>'price')::numeric,md5(p::text));
   end if;
 else
   if exists(select 1 from ssma_epi.invoices h where h.id=(p->>'id')::uuid and h.actor=auth.uid() and unit_id=dest and h.request_hash=md5(p::text)) then return '{"ok":true}'; end if;
   if action<>'invoice' then
     select * into doc from ssma_epi.invoices h where h.id=(p->>'id')::uuid and h.unit_id=dest for update;
     if not found then raise exception 'Nota fiscal indisponível. Atualize a lista.'; end if;
     if action='edit_invoice' and doc.request_hash=md5(p::text) then return '{"ok":true}'; end if;
     if doc.request_hash is distinct from p->>'previous' then raise exception 'A nota foi alterada. Atualize a lista antes de continuar.'; end if;
     previous_items:=doc.items;
     select min(v.created_at),max(v.cleared_at) into movement_stamp,cleared from ssma_epi.movements v where v.invoice_id=doc.id;
   end if;
   if action<>'delete_invoice' then
     if jsonb_typeof(p->'items') is distinct from 'array' or jsonb_array_length(p->'items') not between 1 and 100 then raise exception 'Adicione de 1 a 100 itens.'; end if;
     if action='invoice' then
       insert into ssma_epi.invoices values((p->>'id')::uuid,dest,auth.uid(),invoice_cnpj,trim(p->>'number'),coalesce(trim(p->>'series'),''),(p->>'date')::date,p->'items',0,md5(p::text));
     else
       update ssma_epi.invoices set cnpj=invoice_cnpj,number=trim(p->>'number'),series=coalesce(trim(p->>'series'),''),issued=(p->>'date')::date,request_hash=md5(p::text) where id=doc.id;
     end if;
     for item in select value from jsonb_array_elements(p->'items') order by value->>'material_id' loop
       amount:=(item->>'qty')::int; cost:=(item->>'price')::numeric;
       if amount is null or amount<1 or cost is null or cost<0 or cost<>round(cost,2) then raise exception 'Confira quantidade e valor unitário.'; end if;
       mid:=nullif(item->>'material_id','')::uuid;
       if mid is null then
         insert into ssma_epi.materials(owner_id,region_id,stock_center,name,ca,no_ca,qty,price,size,color,insulating_glove,glove_start)
         values(auth.uid(),dest,'SSMA',trim(item->>'name'),trim(coalesce(item->>'ca','')),(item->>'no_ca')::boolean,0,cost,coalesce(item->>'size',''),trim(coalesce(item->>'color','')),
         coalesce((item->>'glove')::boolean,false) or ssma_epi.is_glove(item->>'name',item->>'ca'),nullif(item->>'glove_start','')::date) returning id into mid;
       end if;
       select * into strict m from ssma_epi.materials where id=mid and region_id=dest;
       new_items:=new_items||jsonb_build_array(jsonb_build_object('material_id',mid,'name',m.name,'ca',m.ca,'no_ca',m.no_ca,'size',m.size,'color',m.color,'qty',amount,'price',cost));
       invoice_total:=invoice_total+amount*cost;
     end loop;
   end if;
   for delta in
     select material_id,sum(n)::int as units,sum(v) as value from (
       select material_id,qty as n,qty*price as v from jsonb_to_recordset(new_items) as a(material_id uuid,qty int,price numeric)
       union all select material_id,-qty,-qty*price from jsonb_to_recordset(previous_items) as b(material_id uuid,qty int,price numeric)
     ) changes group by material_id order by material_id
   loop
     select * into strict m from ssma_epi.materials where id=delta.material_id and region_id=dest for update;
     if delta.units=0 and delta.value=0 then continue; end if;
     new_qty:=m.qty+delta.units;
     new_value:=m.qty*m.price+delta.value;
     if new_qty<m.reserved or (new_qty>0 and new_value<0) or (m.archived_at is not null and new_qty>0) or (new_qty=0 and delta.units=0 and delta.value<>0) then
       raise exception 'O ajuste de % é incompatível com o saldo, o custo ou as reservas atuais.',m.name;
     end if;
     update ssma_epi.materials set qty=new_qty,price=case when new_qty>0 then round(new_value/new_qty,2) else m.price end where id=m.id;
   end loop;
   if action='delete_invoice' then delete from ssma_epi.invoices where id=doc.id;
   else
     delete from ssma_epi.movements where invoice_id=doc.id;
     insert into ssma_epi.movements(owner_id,region_id,material_id,kind,qty,price,invoice_id,created_at,cleared_at)
       select coalesce(doc.actor,auth.uid()),dest,a.material_id,'Entrada',a.qty,a.price,(p->>'id')::uuid,coalesce(movement_stamp,now()),cleared
       from jsonb_to_recordset(new_items) a(material_id uuid,qty int,price numeric);
     update ssma_epi.invoices set total=invoice_total,items=new_items where id=(p->>'id')::uuid;
   end if;
 end if;
 return '{"ok":true}';
end $function$;
