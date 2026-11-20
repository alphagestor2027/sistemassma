create schema ssma_epi;
revoke all on schema ssma_epi from public;
grant usage on schema ssma_epi to authenticated, anon;

create table ssma_epi.regions (
 id uuid primary key default gen_random_uuid(),
 owner_id uuid not null references public.ssma_profiles(user_id),
 state text not null check (state in ('AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG','PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO')),
 name text not null check (trim(name) <> ''),
 technician_id uuid not null references public.ssma_profiles(user_id),
 unique(owner_id,state,name)
);
create index epi_region_tech on ssma_epi.regions(technician_id);
create table ssma_epi.assignments (
 employee_id uuid not null references public.ssma_records(id) on delete cascade,
 state text not null, region_id uuid not null references ssma_epi.regions(id),
 project text not null check(trim(project) <> ''), job text not null check(trim(job) <> ''),
 center text not null default '', contract text not null default '',
 primary key(employee_id,state)
);
create index epi_assignment_region on ssma_epi.assignments(region_id);
create table ssma_epi.access_keys (
 employee_id uuid primary key references public.ssma_records(id) on delete cascade,
 token_hash bytea unique not null
);
create table ssma_epi.materials (
 id uuid primary key default gen_random_uuid(), owner_id uuid not null references public.ssma_profiles(user_id),
 region_id uuid references ssma_epi.regions(id),
 name text not null check(trim(name) <> ''), ca text not null, no_ca boolean not null default false,
 check ((no_ca and ca='') or (not no_ca and trim(ca) <> '')),
 price numeric(14,2) not null default 0 check(price>=0),
 qty integer not null default 0 check(qty>=0), reserved integer not null default 0 check(reserved between 0 and qty),
 minimum integer not null default 0 check(minimum>=0), expiry date,
 size text not null default '', color text not null default ''
);
create index epi_material_owner on ssma_epi.materials(owner_id);
create index epi_material_region on ssma_epi.materials(region_id);
create table ssma_epi.requests (
 id uuid primary key, owner_id uuid not null, employee_id uuid not null, region_id uuid not null references ssma_epi.regions(id),
 employee text not null, state text not null, project text not null, job text not null,
 technician text not null, center text not null, contract text not null,
 status text not null default 'Solicitado' check(status in ('Solicitado','Entregue','Cancelado')),
 created_at timestamptz not null default now(), closed_at timestamptz, confirmed_by uuid, confirmed_name text,
 destination text check(destination in ('Projeto','SSMA'))
);
create index epi_request_owner on ssma_epi.requests(owner_id);
create index epi_request_employee on ssma_epi.requests(employee_id,created_at desc);
create index epi_request_region on ssma_epi.requests(region_id);
create table ssma_epi.lines (
 request_id uuid not null references ssma_epi.requests(id), material_id uuid not null references ssma_epi.materials(id),
 name text not null, ca text not null, size text not null, color text not null, qty integer not null check(qty>0),
 price numeric(14,2), primary key(request_id,material_id)
);
create table ssma_epi.movements (
 id uuid primary key default gen_random_uuid(), owner_id uuid not null, region_id uuid references ssma_epi.regions(id),
 material_id uuid not null references ssma_epi.materials(id), request_id uuid references ssma_epi.requests(id),
 kind text not null check(kind in ('Entrada','Saída')), qty integer not null check(qty>0),
 price numeric(14,2) not null check(price>=0), created_at timestamptz not null default now()
);
create index epi_mov_owner on ssma_epi.movements(owner_id);
create index epi_mov_region on ssma_epi.movements(region_id);
create table ssma_epi.rules (
 material_id uuid not null references ssma_epi.materials(id), job text not null check(trim(job)<>''),
 days integer not null check(days>0), qty integer not null check(qty>0), primary key(material_id,job)
);
create table ssma_epi.assets (
 id uuid primary key default gen_random_uuid(), request_id uuid not null, material_id uuid not null,
 owner_id uuid not null, serial text not null check(trim(serial)<>''), period_days int not null check(period_days>0),
 due date not null, status text not null default 'Em uso', lab text not null default '',
 unique(owner_id,serial), foreign key(request_id,material_id) references ssma_epi.lines(request_id,material_id)
);
create index epi_assets_line on ssma_epi.assets(request_id,material_id);
create table ssma_epi.tests (
 id bigint generated always as identity primary key, asset_id uuid not null references ssma_epi.assets(id),
 status text not null, lab text not null, report text not null, created_at timestamptz not null default now()
);
create index epi_test_asset on ssma_epi.tests(asset_id);

-- The API exposes functions only. These tables have no direct client grants.
do $$ declare t text; begin
 foreach t in array array['regions','assignments','access_keys','materials','requests','lines','movements','rules','assets','tests'] loop
 execute format('alter table ssma_epi.%I enable row level security',t);
 execute format('revoke all on ssma_epi.%I from public, anon, authenticated',t);
 end loop;
end $$;

create function ssma_epi.workspace() returns jsonb language sql stable security definer set search_path='' as $$
 with regions as (
 select r.*, p.display_name technician, p.username technician_login from ssma_epi.regions r
 join public.ssma_profiles p on p.user_id=r.technician_id where auth.uid() in(r.owner_id,r.technician_id)
 ), materials as (
 select m.* from ssma_epi.materials m where m.owner_id=auth.uid() or m.region_id in(select id from regions)
 ), requests as (
 select q.*, coalesce((select jsonb_agg(to_jsonb(l) order by l.name,l.material_id) from ssma_epi.lines l where l.request_id=q.id),'[]') items
 from ssma_epi.requests q where q.region_id in(select id from regions)
 ), assets as (
 select a.*, coalesce((select jsonb_agg(to_jsonb(t) order by t.id desc) from ssma_epi.tests t where t.asset_id=a.id),'[]') history
 from ssma_epi.assets a where a.request_id in(select id from requests)
 )
 select jsonb_build_object(
 'regions',coalesce((select jsonb_agg(to_jsonb(r) order by r.state,r.name) from regions r),'[]'),
 'assignments',coalesce((select jsonb_agg(to_jsonb(a)||jsonb_build_object('active',e.status='Ativo','employee',e.title)) from ssma_epi.assignments a join public.ssma_records e on e.id=a.employee_id where a.region_id in(select id from regions)),'[]'),
 'materials',coalesce((select jsonb_agg(to_jsonb(m) order by m.name,m.size,m.color) from materials m),'[]'),
 'requests',coalesce((select jsonb_agg(to_jsonb(q) order by q.created_at desc) from requests q),'[]'),
 'movements',coalesce((select jsonb_agg(to_jsonb(v) order by v.created_at desc) from ssma_epi.movements v where v.owner_id=auth.uid() or v.region_id in(select id from regions)),'[]'),
 'rules',coalesce((select jsonb_agg(to_jsonb(s)) from ssma_epi.rules s where s.material_id in(select id from materials)),'[]'),
 'assets',coalesce((select jsonb_agg(to_jsonb(a) order by a.due) from assets a),'[]')
 ) where exists(select 1 from public.ssma_profiles where user_id=auth.uid());
$$;

create function ssma_epi.manage(action text, p jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare
 actor uuid := auth.uid(); reg ssma_epi.regions; mat ssma_epi.materials; req ssma_epi.requests;
 line ssma_epi.lines; asset ssma_epi.assets; rec public.ssma_records; tech uuid; secret text;
 amount int; cost numeric(14,2); target text; item_id uuid; region_id_arg uuid := nullif(p->>'region_id','')::uuid;
begin
 if not exists(select 1 from public.ssma_profiles where user_id=actor) then raise exception 'Acesso restrito.'; end if;
 if region_id_arg is not null then
 select * into strict reg from ssma_epi.regions where id=region_id_arg and owner_id=actor;
 end if;
 case action
 when 'region' then
 select user_id into tech from public.ssma_profiles where username=trim(p->>'login');
 if tech is null then raise exception 'Login do técnico não encontrado.'; end if;
 insert into ssma_epi.regions(owner_id,state,name,technician_id) values(actor,p->>'state',trim(p->>'name'),tech)
 on conflict(owner_id,state,name) do update set technician_id=excluded.technician_id;
 when 'assignment','key' then
 select * into strict rec from public.ssma_records where id=(p->>'employee_id')::uuid and owner_id=actor and module='colaboradores' and status='Ativo';
 if action='key' then
 secret:=replace(gen_random_uuid()::text,'-','')||replace(gen_random_uuid()::text,'-','');
 insert into ssma_epi.access_keys values(rec.id,sha256(convert_to(secret,'UTF8')))
 on conflict(employee_id) do update set token_hash=excluded.token_hash;
 return to_jsonb(secret);
 end if;
 insert into ssma_epi.assignments(employee_id,state,region_id,project,job,center,contract)
 values(rec.id,reg.state,reg.id,trim(p->>'project'),trim(p->>'job'),trim(coalesce(p->>'center','')),trim(coalesce(p->>'contract','')))
 on conflict(employee_id,state) do update set region_id=excluded.region_id,project=excluded.project,job=excluded.job,center=excluded.center,contract=excluded.contract;
 when 'material' then
 amount:=coalesce(nullif(p->>'qty','')::integer,0); cost:=coalesce(nullif(p->>'price','')::numeric,0);
 insert into ssma_epi.materials(id,owner_id,region_id,name,ca,no_ca,price,qty,minimum,expiry,size,color)
 values((p->>'id')::uuid,actor,reg.id,trim(p->>'name'),trim(coalesce(p->>'ca','')),coalesce((p->>'no_ca')::boolean,false),
 cost,amount,coalesce(nullif(p->>'minimum','')::int,0),nullif(p->>'expiry','')::date,trim(coalesce(p->>'size','')),trim(coalesce(p->>'color','')))
 returning * into mat;
 if amount>0 then insert into ssma_epi.movements(owner_id,region_id,material_id,kind,qty,price) values(actor,reg.id,mat.id,'Entrada',amount,cost); end if;
 when 'entry','allocate','rule' then
 select * into strict mat from ssma_epi.materials where id=(p->>'material_id')::uuid and (owner_id=actor or region_id in(select id from ssma_epi.regions where technician_id=actor)) for update;
 if action='entry' then
 amount:=(p->>'qty')::int; cost:=coalesce(nullif(p->>'price','')::numeric,mat.price);
 insert into ssma_epi.movements(id,owner_id,region_id,material_id,kind,qty,price) values((p->>'id')::uuid,mat.owner_id,mat.region_id,mat.id,'Entrada',amount,cost);
 update ssma_epi.materials set price=round((price*qty+cost*amount)/(qty+amount),2),qty=qty+amount where id=mat.id;
 elsif action='allocate' then
 if mat.region_id is not null or reg.id is null or reg.owner_id<>mat.owner_id then raise exception 'Selecione um material sem regional e uma regional válida.'; end if;
 update ssma_epi.materials set region_id=reg.id where id=mat.id;
 update ssma_epi.movements set region_id=reg.id where material_id=mat.id and region_id is null;
 else
 insert into ssma_epi.rules values(mat.id,lower(trim(p->>'job')),(p->>'days')::int,(p->>'qty')::int)
 on conflict(material_id,job) do update set days=excluded.days,qty=excluded.qty;
 end if;
 when 'deliver','cancel' then
 select q.* into strict req from ssma_epi.requests q join ssma_epi.regions r on r.id=q.region_id
 where q.id=(p->>'request_id')::uuid and (r.technician_id=actor or (action='cancel' and r.owner_id=actor)) for update of q;
 if req.status<>'Solicitado' then raise exception 'Solicitação já encerrada.'; end if;
 target:=p->>'destination';
 if action='deliver' and (target is null or target not in ('Projeto','SSMA')) then raise exception 'Confirme o destino do custo.'; end if;
 for line in select * from ssma_epi.lines where request_id=req.id order by material_id loop
 select * into strict mat from ssma_epi.materials where id=line.material_id for update;
 if action='deliver' and mat.expiry < (now() at time zone 'America/Sao_Paulo')::date then raise exception 'Material vencido. Cancele a reserva e selecione outro material.'; end if;
 update ssma_epi.materials set reserved=reserved-line.qty,qty=qty-case when action='deliver' then line.qty else 0 end where id=mat.id;
 if action='deliver' then
 update ssma_epi.lines set price=mat.price where request_id=req.id and material_id=mat.id;
 insert into ssma_epi.movements(owner_id,region_id,material_id,request_id,kind,qty,price)
 values(req.owner_id,req.region_id,mat.id,req.id,'Saída',line.qty,mat.price);
 end if;
 end loop;
 update ssma_epi.requests set status=case when action='deliver' then 'Entregue' else 'Cancelado' end,
 closed_at=now(),confirmed_by=actor,confirmed_name=(select display_name from public.ssma_profiles where user_id=actor),
 destination=case when action='deliver' then target end where id=req.id;
 when 'asset' then
 select q.* into strict req from ssma_epi.requests q join ssma_epi.regions r on r.id=q.region_id
 where q.id=(p->>'request_id')::uuid and actor in(r.owner_id,r.technician_id) and q.status='Entregue' for update of q;
 item_id:=(p->>'material_id')::uuid;
 select * into strict line from ssma_epi.lines where request_id=req.id and material_id=item_id;
 if (select count(*) from ssma_epi.assets where request_id=req.id and material_id=item_id)>=line.qty then raise exception 'Todas as unidades da entrega já têm série.'; end if;
 insert into ssma_epi.assets(owner_id,request_id,material_id,serial,period_days,due) values(req.owner_id,req.id,item_id,trim(p->>'serial'),(p->>'days')::int,(p->>'due')::date);
 when 'test' then
 select a.* into strict asset from ssma_epi.assets a join ssma_epi.requests q on q.id=a.request_id join ssma_epi.regions r on r.id=q.region_id
 where a.id=(p->>'asset_id')::uuid and actor in(r.owner_id,r.technician_id) for update of a;
 target:=p->>'status';
 if not coalesce((asset.status='Em uso' and target='Em trânsito') or (asset.status='Em trânsito' and target='No laboratório')
 or (asset.status='No laboratório' and target in ('Em retorno','Reprovado')) or (asset.status='Em retorno' and target='Em uso'),false)
 then raise exception 'Transição de ensaio inválida.'; end if;
 if target='Em trânsito' and nullif(trim(p->>'lab'),'') is null then raise exception 'Informe o laboratório.'; end if;
 if target in ('Em retorno','Reprovado') and nullif(trim(p->>'report'),'') is null then raise exception 'Informe o número ou resultado do laudo.'; end if;
 update ssma_epi.assets set status=target,lab=case when target='Em trânsito' then trim(p->>'lab') else lab end,
 due=case when target='Em retorno' then (now() at time zone 'America/Sao_Paulo')::date+period_days else due end where id=asset.id returning * into asset;
 insert into ssma_epi.tests(asset_id,status,lab,report) values(asset.id,target,asset.lab,trim(coalesce(p->>'report','')));
 else raise exception 'Operação desconhecida.';
 end case;
 return jsonb_build_object('ok',true);
exception when no_data_found then raise exception 'Registro indisponível para este usuário.';
end $$;

create function ssma_epi.portal(action text, p jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare
 token text:=nullif(p->>'token',''); actor uuid:=auth.uid(); holder uuid;
 emp public.ssma_records; a ssma_epi.assignments; r ssma_epi.regions; tech text;
 mat ssma_epi.materials; item record; result jsonb; req_id uuid; inserted uuid;
begin
 if token is not null then
 select k.employee_id into holder from ssma_epi.access_keys k join public.ssma_records e on e.id=k.employee_id
 where k.token_hash=sha256(convert_to(token,'UTF8')) and e.module='colaboradores' and e.status='Ativo';
 if holder is null then raise exception 'Código de acesso inválido ou substituído.'; end if;
 elsif actor is null or not exists(select 1 from public.ssma_profiles where user_id=actor) then raise exception 'Informe o código de acesso individual.'; end if;
 if action='names' then
 select coalesce(jsonb_agg(jsonb_build_object('id',e.id,'name',e.title) order by e.title,e.id),'[]') into result
 from public.ssma_records e where e.module='colaboradores' and e.status='Ativo' and
 (case when token is null then e.owner_id=actor else e.id=holder end)
 and exists(select 1 from ssma_epi.assignments v where v.employee_id=e.id);
 return result;
 end if;
 select * into emp from public.ssma_records e where e.id=(p->>'employee_id')::uuid and e.module='colaboradores' and e.status='Ativo'
 and (case when token is null then e.owner_id=actor else e.id=holder end);
 if emp.id is null then raise exception 'Colaborador indisponível.'; end if;
 if action='states' then return (select coalesce(jsonb_agg(v.state order by v.state),'[]') from ssma_epi.assignments v where v.employee_id=emp.id); end if;
 select * into a from ssma_epi.assignments where employee_id=emp.id and state=p->>'state' for share;
 if a.region_id is null then raise exception 'Vínculo com a regional não encontrado.'; end if;
 select * into strict r from ssma_epi.regions where id=a.region_id and owner_id=emp.owner_id for share;
 select display_name into tech from public.ssma_profiles where user_id=r.technician_id;
 if action='context' then
 return jsonb_build_object('project',a.project,'job',a.job,'technician',tech,'region',r.name,
 'materials',(select coalesce(jsonb_agg(jsonb_build_object('id',m.id,'name',m.name,'ca',m.ca,'size',m.size,'color',m.color,'available',m.qty-m.reserved) order by m.name,m.size),'[]')
 from ssma_epi.materials m where m.region_id=r.id and m.qty>m.reserved and (m.expiry is null or m.expiry>=(now() at time zone 'America/Sao_Paulo')::date)),
 'history',(select coalesce(jsonb_agg(jsonb_build_object('id',q.id,'date',q.created_at,'status',q.status,'state',q.state,'project',q.project,
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
 = (select jsonb_agg(v order by v->>'id') from jsonb_array_elements(p->'items') v) then return to_jsonb(req_id); end if;
 raise exception 'Identificador de solicitação já utilizado.';
 end if;
 for item in select * from jsonb_to_recordset(p->'items') as i(id uuid,qty integer) order by id loop
 select * into mat from ssma_epi.materials where id=item.id and region_id=r.id for update;
 if mat.id is null or item.qty is null or item.qty<=0 or item.qty>mat.qty-mat.reserved
 or mat.expiry<(now() at time zone 'America/Sao_Paulo')::date then raise exception 'Saldo insuficiente ou material indisponível. Atualize os materiais.'; end if;
 insert into ssma_epi.lines(request_id,material_id,name,ca,size,color,qty) values(req_id,mat.id,mat.name,mat.ca,mat.size,mat.color,item.qty);
 update ssma_epi.materials set reserved=reserved+item.qty where id=mat.id;
 end loop;
 return to_jsonb(req_id);
end $$;

create function public.ssma_epi_workspace() returns jsonb language sql stable security invoker set search_path='' as $$ select ssma_epi.workspace() $$;
create function public.ssma_epi_manage(action text,p jsonb) returns jsonb language sql security invoker set search_path='' as $$ select ssma_epi.manage(action,p) $$;
create function public.ssma_epi_portal(action text,p jsonb) returns jsonb language sql security invoker set search_path='' as $$ select ssma_epi.portal(action,p) $$;
revoke all on all functions in schema ssma_epi from public,anon,authenticated;
revoke all on function public.ssma_epi_workspace(),public.ssma_epi_manage(text,jsonb),public.ssma_epi_portal(text,jsonb) from public,anon,authenticated;
grant execute on function ssma_epi.workspace(),ssma_epi.manage(text,jsonb),public.ssma_epi_workspace(),public.ssma_epi_manage(text,jsonb) to authenticated;
grant execute on function ssma_epi.portal(text,jsonb),public.ssma_epi_portal(text,jsonb) to anon,authenticated;

create function ssma_epi.dashboard() returns table(id uuid, title text, unit text,status text,event_date date)
language sql stable security definer set search_path='' as $$
 select q.id, 'Pedido de EPI · '||q.employee, q.project, case q.status when 'Entregue' then 'Concluído' when 'Cancelado' then 'Inativo' else 'Pendente' end,
 (q.created_at at time zone 'America/Sao_Paulo')::date from ssma_epi.requests q join ssma_epi.regions r on r.id=q.region_id where auth.uid() in(r.owner_id,r.technician_id)
$$;
create function public.ssma_epi_dashboard() returns table(id uuid,title text,unit text,status text,event_date date)
language sql stable security invoker set search_path='' as $$ select * from ssma_epi.dashboard() $$;
revoke all on function ssma_epi.dashboard(),public.ssma_epi_dashboard() from public,anon,authenticated;
grant execute on function ssma_epi.dashboard(),public.ssma_epi_dashboard() to authenticated;
