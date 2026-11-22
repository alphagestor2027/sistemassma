create table ssma_epi.sheet_drafts (
 request_id uuid primary key references ssma_epi.requests(id) on delete cascade,
 employee_id uuid not null references public.ssma_records(id) on delete cascade,
 payload jsonb not null
);
revoke all on ssma_epi.sheet_drafts from public,anon,authenticated;
alter table ssma_epi.sheets add column request_id uuid unique;
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
   if action='issue' and source.status<>'Entregue' then raise exception 'Confirme a entrega antes de concluir a ficha.'; end if;
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
   if action='delete' then delete from ssma_epi.sheets where id=doc.id; return jsonb_build_object('ok',true); end if;
   snap:=doc.snapshot;
 elsif action in ('context','issue','draft') then
   select coalesce(jsonb_agg(jsonb_build_object('key',q.id::text||'/'||l.material_id::text,'date',(coalesce(q.closed_at,q.created_at) at time zone 'America/Sao_Paulo')::date,
     'reason',l.reason,'ca',l.ca,'equipment',concat_ws(' · ',l.name,nullif(l.size,''),nullif(l.color,'')),'qty',l.qty,
     'state',q.state,'region_id',q.region_id,'employee',q.employee,'project',q.project,'job',q.job) order by q.closed_at,q.id,l.name,l.material_id),'[]') into items
   from ssma_epi.requests q join ssma_epi.lines l on l.request_id=q.id join ssma_epi.regions r on r.id=q.region_id
   where q.employee_id=emp and ((source_id is null and q.status='Entregue') or q.id=source_id) and ssma_epi.can_use_stock(r) and ssma_epi.request_in_area(emp,q.state);
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
   return jsonb_build_object('draft',draft_payload,'snapshot',snap,'version',md5(snap::text||coalesce(draft_payload::text,'')),'sheets',list,'template',template,'materials',(select coalesce(jsonb_agg(jsonb_build_object('id',m.id,'name',concat_ws(' · ',m.name,nullif(m.size,''),nullif(m.color,'')),'available',m.qty-m.reserved) order by m.name,m.size,m.id),'[]') from ssma_epi.materials m join ssma_epi.regions r on r.id=m.region_id where e.status='Ativo' and m.region_id=ssma_epi.employee_unit(e) and exists(select 1 from ssma_epi.assignments a where a.employee_id=e.id and a.state=e.employee_state and a.region_id=r.id) and ssma_epi.can_use_stock(r) and m.archived_at is null and m.qty>m.reserved and (m.expiry is null or m.expiry>=(now() at time zone 'America/Sao_Paulo')::date) and (not m.insulating_glove or (now() at time zone 'America/Sao_Paulo')::date between m.glove_start and m.glove_start+365)));
 end if;
 if action in ('draft','issue') and md5(snap::text||coalesce(draft_payload::text,'')) is distinct from p->>'version' then raise exception 'As entregas ou o cadastro mudaram. Reabra a prévia.'; end if;
 opts:=p->'settings';
 if source_id is not null and jsonb_array_length(coalesce(p->'new_items','[]'))>0 then raise exception 'Use os itens da ficha vinculada.'; end if;
 if action='issue' and jsonb_array_length(coalesce(p->'new_items','[]'))>0 then
   perform ssma_epi.sheet_delivery(e,(p->>'id')::uuid,p->'new_items');
   snap:=ssma_epi.sheet('context',p)->'snapshot';
   opts:=jsonb_set(opts,'{identity,unit}',to_jsonb(e.unit));
   opts:=jsonb_set(opts,'{reasons}',(opts->'reasons') || (select jsonb_object_agg((p->>'id')||'/'||l.material_id,l.reason) from ssma_epi.lines l where l.request_id=(p->>'id')::uuid));
 end if;
 if action='edit' and exists(select 1 from ssma_epi.requests q where q.id=doc.id) then
   opts:=jsonb_set(opts,'{identity,unit}',snap->'unit');
 end if;
 if action='edit' or source_id is not null then
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
