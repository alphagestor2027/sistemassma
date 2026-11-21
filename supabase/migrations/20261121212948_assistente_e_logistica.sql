-- The report keeps the same unit, employee and coverage checks as the glove dashboard.
create function ssma_epi.glove_evidence() returns jsonb
language sql stable security definer set search_path = '' as $$
  with deliveries as (
    select e.id as employee_id, e.title as employee, coalesce(e.employee_state,q.state) as state,
      l.request_id, l.material_id, q.region_id, l.size, l.ca, l.name as material, l.qty, l.glove_due
    from ssma_epi.lines l
    join ssma_epi.requests q on q.id = l.request_id and q.status = 'Entregue'
    join public.ssma_records e on e.id = q.employee_id and e.module = 'colaboradores' and e.status = 'Ativo'
    join ssma_epi.regions r on r.id = q.region_id
    join public.ssma_profiles p on p.user_id = auth.uid() and p.active
    where l.delivered_glove and (p.is_master or p.permissions && array['epi.estoque','epi.ensaios','epi.solicitacoes','epi.ficha'])
      and (p.is_master or coalesce(e.employee_state,q.state) = any(p.coverage))
      and ssma_epi.can_use_stock(r) and ssma_epi.request_in_area(e.id,q.state)
  ), tracked as (
    select d.request_id, d.material_id, a.id, a.status = 'Reprovado' as rejected,
      case when renewal.day is null then d.glove_due else least(a.due, renewal.day + 365) end as due
    from deliveries d join ssma_epi.assets a using (request_id, material_id)
    left join lateral (
      select (max(t.created_at) at time zone 'America/Sao_Paulo')::date as day
      from ssma_epi.tests t where t.asset_id = a.id and t.status = 'Em retorno'
    ) renewal on true
  ), assigned_counts as (
    select request_id, material_id, count(*) as qty from tracked group by request_id, material_id
  ), quantities as (
    select d.*, t.due, t.rejected, 1 as quantity
    from deliveries d join tracked t using (request_id, material_id)
    union all
    select d.*, d.glove_due, false, d.qty - coalesce(c.qty, 0) as quantity
    from deliveries d left join assigned_counts c using (request_id, material_id)
  ), summary as (
    select employee_id, employee, state, material_id, region_id, size, ca, material, due, rejected, sum(quantity)::int as qty
    from quantities where quantity > 0
    group by employee_id, employee, state, material_id, region_id, size, ca, material, due, rejected
  )
  select coalesce(jsonb_agg(to_jsonb(s)
    order by rejected desc, due nulls last, employee, material, employee_id, material_id), '[]'::jsonb) from summary s
$$;

create function public.ssma_ai_gloves() returns jsonb language sql stable security invoker set search_path='' as $$
  select ssma_epi.glove_evidence()
$$;
revoke all on function ssma_epi.glove_evidence(), public.ssma_ai_gloves() from public,anon;
grant execute on function ssma_epi.glove_evidence(), public.ssma_ai_gloves() to authenticated;

alter table public.ssma_profiles drop constraint ssma_permissions_valid;
alter table public.ssma_profiles add constraint ssma_permissions_valid check
 (permissions <@ array['colaboradores','exames','prontuarios','afastamentos','ergonomia','riscos','acidentes','pt','inspecoes','licencas','residuos','emissoes','laia','esocial','treinamentos','terceiros','requisitos','bi','epi.estoque','epi.solicitacoes','epi.financeiro','epi.ficha','epi.ensaios','epi.compras','epi.historico','epi.anteriores','epi.correios']::text[] and array_position(permissions,null) is null);
update public.ssma_profiles set permissions=array_replace(permissions,'epi.ensaios','epi.correios') where 'epi.ensaios'=any(permissions);

create table ssma_epi.invoices (
 id uuid primary key, unit_id uuid not null references ssma_epi.regions(id), actor uuid not null,
 cnpj text not null check(cnpj ~ '^[A-Z0-9]{12}[0-9]{2}$'), number text not null check(length(trim(number)) between 1 and 40),
 series text not null default '', issued date not null, items jsonb not null, total numeric(16,2) not null, request_hash text not null,
 unique(unit_id,cnpj,series,number)
);
alter table ssma_epi.movements add column invoice_id uuid references ssma_epi.invoices(id) on delete cascade;
create index epi_movement_invoice on ssma_epi.movements(invoice_id) where invoice_id is not null;
create table ssma_epi.shipments (
 id uuid primary key, unit_id uuid not null references ssma_epi.regions(id), actor uuid not null, sent date not null,
 tracking text not null check(length(tracking) between 4 and 64), employee_id uuid, recipient text not null check(length(trim(recipient)) between 1 and 200),
 project text not null check(length(trim(project)) between 1 and 120), state text not null,
 mode text not null check(mode in ('PAC','SEDEX','SEDEX 10','SEDEX 12','SEDEX Hoje','Mini Envios','Carta registrada','Outra')),
 cost numeric(14,2) not null check(cost>=0), request_hash text not null, unique(unit_id,tracking)
);
revoke all on ssma_epi.invoices,ssma_epi.shipments from public,anon,authenticated;
create index shipments_unit_date on ssma_epi.shipments(unit_id,sent);
create function public.ssma_epi_logistics(action text,p jsonb default '{}') returns jsonb
language plpgsql security definer set search_path='' as $$
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
     label:=e.title; project:=e.unit; uf:=e.employee_state;
   else label:=trim(p->>'recipient'); project:=trim(p->>'project'); uf:=p->>'state'; end if;
   if not exists(select 1 from jsonb_each(ssma_epi.service_areas()) a where a.value ? uf)
      or not (actor.is_master or uf=any(actor.coverage)) then raise exception 'UF fora da área de atendimento.'; end if;
   if action='edit_ship' then
     update ssma_epi.shipments set sent=(p->>'date')::date,tracking=upper(trim(p->>'tracking')),employee_id=e.id,recipient=label,
       project=case when e.id is null then trim(p->>'project') else e.unit end,state=uf,mode=p->>'mode',cost=(p->>'price')::numeric,request_hash=md5(p::text) where id=shipment.id;
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
   -- Apply the net difference under each material lock, so metadata edits also work after deliveries.
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
end $$;
revoke all on function public.ssma_epi_logistics(text,jsonb) from public,anon;
grant execute on function public.ssma_epi_logistics(text,jsonb) to authenticated;
create table ssma_epi.ai_server (singleton boolean primary key check(singleton), key_hash text not null);
create table ssma_epi.ai_events (
 id bigint generated always as identity primary key, stamp timestamptz not null default now(),
 request_id uuid not null, provider text not null, model text not null, operation text not null, code text not null,
 http integer, duration integer, detail text, retry_at timestamptz
);
create index ai_events_provider on ssma_epi.ai_events(provider,id desc);
create table ssma_epi.ai_limits (bucket text primary key, minute timestamptz not null, used int not null);
create table ssma_epi.ai_help (topic text primary key, updated timestamptz, answer jsonb);
revoke all on ssma_epi.ai_server,ssma_epi.ai_events,ssma_epi.ai_limits,ssma_epi.ai_help from public,anon,authenticated;

create function public.ssma_ai_control(action text,p jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare t timestamptz:=date_trunc('minute',now()); hits integer; scope text;
begin
 if not exists(select 1 from ssma_epi.ai_server where key_hash=encode(sha256(convert_to(current_setting('request.headers',true)::jsonb->>'x-ssma-ai','UTF8')),'hex')) then raise insufficient_privilege; end if;
 if action='reserve' then
   scope:=coalesce(auth.uid()::text,'portal');
   insert into ssma_epi.ai_limits as l values(scope,t,1) on conflict(bucket) do update set minute=t,used=case when l.minute=t then l.used+1 else 1 end returning used into hits;
   if hits>(case when scope='portal' then 10 else 8 end) then raise exception 'Aguarde um minuto antes de consultar novamente.'; end if;
   return (select coalesce(jsonb_object_agg(provider,retry_at),'{}') from (select distinct on(provider) provider,retry_at from ssma_epi.ai_events order by provider,id desc) s where retry_at>now());
 elsif action='event' then
   insert into ssma_epi.ai_events(request_id,provider,model,operation,code,http,duration,detail,retry_at) values((p->>'request_id')::uuid,p->>'provider',p->>'model',p->>'operation',p->>'code',(p->>'http')::int,(p->>'duration')::int,left(p->>'detail',400),(p->>'retry_at')::timestamptz);
   delete from ssma_epi.ai_events where stamp<now()-interval '30 days';
 elsif action='status' then
   if not exists(select 1 from public.ssma_profiles where user_id=auth.uid() and active and is_master) then raise insufficient_privilege; end if;
   return jsonb_build_object('logs',(select coalesce(jsonb_agg(to_jsonb(x) order by id desc),'[]') from(select * from ssma_epi.ai_events order by id desc limit 100)x),
     'latest',(select coalesce(jsonb_agg(to_jsonb(x)),'[]') from(select distinct on(provider) * from ssma_epi.ai_events order by provider,id desc)x));
 elsif action='help_read' then
   return (select answer from ssma_epi.ai_help where topic=p->>'topic' and updated>now()-interval '24 hours');
 elsif action='help_write' then
   insert into ssma_epi.ai_help values(p->>'topic',now(),p->'answer') on conflict(topic) do update set updated=excluded.updated,answer=excluded.answer;
 else raise exception 'Operação desconhecida.'; end if;
 return '{}'::jsonb;
end $$;
revoke all on function public.ssma_ai_control(text,jsonb) from public;
grant execute on function public.ssma_ai_control(text,jsonb) to anon,authenticated;
create function public.ssma_epi_stock_costs() returns jsonb language sql stable security definer set search_path='' as $$
 select coalesce(jsonb_agg(to_jsonb(z) order by project,state,material),'[]') from (
   select q.project,q.state,l.ca,min(l.name) as material,
     sum(l.qty)::int qty,sum(l.price*l.qty) as cost
   from ssma_epi.requests q join ssma_epi.regions r on r.id=q.region_id join ssma_epi.lines l on l.request_id=q.id
   where ssma_epi.allowed('epi.estoque') and ssma_epi.can_use_stock(r) and ssma_epi.request_in_area(q.employee_id,q.state)
     and q.status='Entregue' and q.destination='Projeto' and not exists(select 1 from ssma_epi.movements v where v.request_id=q.id and v.kind='Saída' and v.cleared_at is not null)
   group by q.project,q.state,l.ca,case when trim(l.ca)='' then l.name end
 ) z
$$;
revoke all on function public.ssma_epi_stock_costs() from public,anon;
grant execute on function public.ssma_epi_stock_costs() to authenticated;
create function public.ssma_ai_order_readiness() returns jsonb language sql stable security definer set search_path='' as $$
 select coalesce(jsonb_agg(to_jsonb(x) order by created_at),'[]') from (
   select q.id,q.created_at,e.title as employee,q.project,count(*)::int as lines,
     string_agg(l.name||' × '||l.qty,', ' order by l.name) as items,
     bool_and(m.archived_at is null and m.region_id=q.region_id and m.qty>=m.reserved and m.reserved>=l.qty
       and (m.expiry is null or m.expiry>=(now() at time zone 'America/Sao_Paulo')::date)
       and (not m.insulating_glove or (now() at time zone 'America/Sao_Paulo')::date between m.glove_start and m.glove_start+365)) as ready
   from ssma_epi.requests q join public.ssma_records e on e.id=q.employee_id and e.module='colaboradores' and e.status='Ativo'
   join ssma_epi.lines l on l.request_id=q.id join ssma_epi.materials m on m.id=l.material_id join ssma_epi.regions r on r.id=q.region_id
   where q.status='Solicitado' and ssma_epi.allowed('epi.solicitacoes') and ssma_epi.can_use_stock(r) and ssma_epi.request_in_area(e.id,q.state)
   group by q.id,e.title
 ) x
$$;
revoke all on function public.ssma_ai_order_readiness() from public,anon;
grant execute on function public.ssma_ai_order_readiness() to authenticated;
