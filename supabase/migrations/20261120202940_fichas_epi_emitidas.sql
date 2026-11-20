create table ssma_epi.sheets (
 id uuid primary key, number bigint generated always as identity unique,
 employee_id uuid not null, author uuid not null, issued_at timestamptz not null default now(),
 revision integer not null default 1, snapshot jsonb not null, settings jsonb not null
);
create index epi_sheets_employee on ssma_epi.sheets(employee_id,number desc);
create table ssma_epi.sheet_templates (company_key text primary key, settings jsonb not null);
alter table ssma_epi.sheets enable row level security;
alter table ssma_epi.sheet_templates enable row level security;
revoke all on ssma_epi.sheets, ssma_epi.sheet_templates from public,anon,authenticated;

create function ssma_epi.sheet(action text,p jsonb) returns jsonb
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
 if action='employees' then
   select coalesce(jsonb_agg(jsonb_build_object('id',z.id,'name',z.name) order by z.name,z.id),'[]') into list
   from (
     select distinct on (v.id) v.id,v.name from (
       select x.id,x.title as name,1 as priority from public.ssma_records x where x.module='colaboradores' and ssma_epi.record_area(x)
       union all select q.employee_id,q.employee,2 from ssma_epi.requests q join ssma_epi.regions r on r.id=q.region_id
         where q.status='Entregue' and ssma_epi.can_use_stock(r) and ssma_epi.request_in_area(q.employee_id,q.state)
       union all select s.employee_id,s.snapshot->>'name',3 from ssma_epi.sheets s where master
     ) v order by v.id,v.priority,v.name
   ) z;
   return list;
 end if;
 select x.* into e from public.ssma_records x where x.id=emp and x.module='colaboradores' and ssma_epi.record_area(x);
 if e.id is null and not exists(select 1 from ssma_epi.requests q join ssma_epi.regions r on r.id=q.region_id
   where q.employee_id=emp and q.status='Entregue' and ssma_epi.can_use_stock(r) and ssma_epi.request_in_area(emp,q.state))
   and not (master and exists(select 1 from ssma_epi.sheets where employee_id=emp)) then
   raise exception 'Colaborador fora da área de atendimento.' using errcode='42501';
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
     'ca',l.ca,'equipment',concat_ws(' · ',l.name,nullif(l.size,''),nullif(l.color,'')),'qty',l.qty,
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
   return jsonb_build_object('snapshot',snap,'version',md5(snap::text),'sheets',list,'template',template);
 end if;
 if action='issue' and md5(snap::text) is distinct from p->>'version' then raise exception 'As entregas ou o cadastro mudaram. Reabra a prévia.'; end if;
 opts:=p->'settings';
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
   insert into ssma_epi.sheets(id,employee_id,author,snapshot,settings) values((p->>'id')::uuid,emp,actor,snap,opts)
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
create function public.ssma_epi_sheet(action text,p jsonb) returns jsonb language sql security invoker set search_path='' as $$select ssma_epi.sheet(action,p)$$;
revoke all on function ssma_epi.sheet(text,jsonb), public.ssma_epi_sheet(text,jsonb) from public,anon,authenticated;
grant execute on function ssma_epi.sheet(text,jsonb), public.ssma_epi_sheet(text,jsonb) to authenticated;
