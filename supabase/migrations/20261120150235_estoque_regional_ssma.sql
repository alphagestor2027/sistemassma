alter table ssma_epi.materials add column insulating_glove boolean not null default false, add column glove_start date;
alter table ssma_epi.materials alter column stock_center set default 'SSMA';
create function ssma_epi.is_glove(n text,ca_number text) returns boolean language sql stable set search_path='' as $$
 select lower(coalesce(n,'')) like '%luva%isolante%' or exists(select 1 from ssma_epi.ca_catalog c cross join lateral jsonb_array_elements(c.fichas) f where c.ca=ltrim(trim(ca_number),'0') and lower(f->>'equipamento') like '%luva%isolante%')
$$;
revoke all on function ssma_epi.is_glove(text,text) from public,anon,authenticated;
update ssma_epi.materials set insulating_glove=ssma_epi.is_glove(name,ca),stock_center='SSMA';
create function ssma_epi.glove_expiry() returns trigger language plpgsql set search_path='' as $$
begin
 if new.insulating_glove then
 if new.glove_start is null then raise exception 'Informe a data do certificado ou do ensaio elétrico.'; end if;
 new.expiry:=new.glove_start+365;
 end if;
 return new;
end $$;
create trigger glove_expiry before insert or update of glove_start on ssma_epi.materials for each row execute function ssma_epi.glove_expiry();
create or replace function ssma_epi.manage_owned(action text, p jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare
 actor uuid := auth.uid(); reg ssma_epi.regions; mat ssma_epi.materials; req ssma_epi.requests;
 line ssma_epi.lines; asset ssma_epi.assets; rec public.ssma_records; tech uuid; secret text;
 amount int; cost numeric(14,2); target text; item_id uuid; region_id_arg uuid := nullif(p->>'region_id','')::uuid;
begin
 if not exists(select 1 from public.ssma_profiles where user_id=actor) then raise exception 'Acesso restrito.'; end if;
 if action in ('material','allocate') and coalesce(p->>'region_state','')<>'' then
 if not exists(select 1 from public.ssma_profiles t where t.user_id=actor and t.active and (t.is_master or p->>'region_state'=any(t.coverage))) then raise exception 'UF fora da área autorizada.'; end if;
 insert into ssma_epi.regions(owner_id,state,name,technician_id) values(actor,p->>'region_state','Estoque '||(p->>'region_state'),actor)
 on conflict(owner_id,state,name) do update set name=excluded.name returning * into reg;
 elsif region_id_arg is not null and action in ('material','allocate') then
 select r.* into strict reg from ssma_epi.regions r join public.ssma_profiles t on t.user_id=actor and t.active
 where r.id=region_id_arg and (t.is_master or (actor in(r.owner_id,r.technician_id) and r.state=any(t.coverage)));
 elsif region_id_arg is not null then
 select * into strict reg from ssma_epi.regions where id=region_id_arg and owner_id=actor;
 end if;
 case action
 when 'region' then
 select user_id into tech from public.ssma_profiles where username=trim(p->>'login');
 if tech is null then raise exception 'Login do técnico não encontrado.'; end if;
 insert into ssma_epi.regions(owner_id,state,name,technician_id) values(actor,p->>'state',trim(p->>'name'),tech)
 on conflict(owner_id,state,name) do update set technician_id=excluded.technician_id;
 when 'assignment' then
 select * into strict rec from public.ssma_records where id=(p->>'employee_id')::uuid and owner_id=actor and module='colaboradores' and status='Ativo';
 insert into ssma_epi.assignments(employee_id,state,region_id,project,job,center,contract)
 values(rec.id,reg.state,reg.id,trim(p->>'project'),trim(p->>'job'),trim(coalesce(p->>'center','')),trim(coalesce(p->>'contract','')))
 on conflict(employee_id,state) do update set region_id=excluded.region_id,project=excluded.project,job=excluded.job,center=excluded.center,contract=excluded.contract;
 when 'material' then
 amount:=coalesce(nullif(p->>'qty','')::integer,0); cost:=coalesce(nullif(p->>'price','')::numeric,0);
 insert into ssma_epi.materials(id,owner_id,region_id,stock_center,name,ca,no_ca,price,qty,minimum,expiry,size,color,insulating_glove,glove_start)
 values((p->>'id')::uuid,actor,reg.id,'SSMA',trim(p->>'name'),trim(coalesce(p->>'ca','')),coalesce((p->>'no_ca')::boolean,false),
 cost,amount,coalesce(nullif(p->>'minimum','')::int,0),nullif(p->>'expiry','')::date,trim(coalesce(p->>'size','')),trim(coalesce(p->>'color','')),coalesce((p->>'insulating_glove')::boolean,false) or ssma_epi.is_glove(p->>'name',p->>'ca'),nullif(p->>'glove_start','')::date)
 returning * into mat;
 if amount>0 then insert into ssma_epi.movements(owner_id,region_id,material_id,kind,qty,price) values(actor,reg.id,mat.id,'Entrada',amount,cost); end if;
 when 'glove_date' then
 update ssma_epi.materials m set glove_start=(p->>'glove_start')::date
 where m.id=(p->>'material_id')::uuid and m.insulating_glove and m.glove_start is not distinct from nullif(p->>'previous','')::date and exists(
 select 1 from public.ssma_profiles t left join ssma_epi.regions r on r.id=m.region_id where t.user_id=actor and t.active and
 (t.is_master or ((r.state=any(t.coverage) and actor in(r.owner_id,r.technician_id,m.owner_id)) or (m.region_id is null and m.owner_id=actor))));
 if not found then raise exception 'Lote indisponível ou já atualizado.'; end if;
 when 'entry','allocate','rule' then
 select * into strict mat from ssma_epi.materials where id=(p->>'material_id')::uuid and (owner_id=actor or region_id in(select id from ssma_epi.regions where technician_id=actor)) for update;
 if action='entry' then
 amount:=(p->>'qty')::int; cost:=coalesce(nullif(p->>'price','')::numeric,mat.price);
 insert into ssma_epi.movements(id,owner_id,region_id,material_id,kind,qty,price) values((p->>'id')::uuid,mat.owner_id,mat.region_id,mat.id,'Entrada',amount,cost);
 update ssma_epi.materials set price=round((price*qty+cost*amount)/(qty+amount),2),qty=qty+amount where id=mat.id;
 elsif action='allocate' then
 if mat.region_id is not null or reg.id is null  then raise exception 'Selecione um material sem regional e uma regional válida.'; end if;
 update ssma_epi.materials set region_id=reg.id where id=mat.id;
 update ssma_epi.movements set region_id=reg.id where material_id=mat.id and region_id is null;
 else
 insert into ssma_epi.rules values(mat.id,lower(trim(p->>'job')),(p->>'days')::int,(p->>'qty')::int)
 on conflict(material_id,job) do update set days=excluded.days,qty=excluded.qty;
 end if;
 when 'progress' then
 select q.* into strict req from ssma_epi.requests q join ssma_epi.regions r on r.id=q.region_id
 where q.id=(p->>'request_id')::uuid and r.technician_id=actor for update of q;
 if req.status<>'Solicitado' then raise exception 'Solicitação já encerrada.'; end if;
 target:=p->>'stage';
 if target is null or target not in ('Pedido recebido','Pedido separado','Aguardando aprovação do projeto','Pronto para retirada na base','Enviado pelos Correios') then raise exception 'Etapa inválida.'; end if;
 if req.stage is distinct from p->>'previous_stage' or req.postal is distinct from coalesce(p->>'previous_postal','') then raise exception 'O pedido mudou. Atualize a lista antes de continuar.'; end if;
 if length(trim(coalesce(p->>'postal','')))>64 then raise exception 'Número de rastreamento muito longo.'; end if;
 if req.stage<>target or req.postal<>upper(trim(coalesce(p->>'postal',''))) then
 update ssma_epi.requests set stage=target, postal=upper(trim(coalesce(p->>'postal',''))),
 events=events||jsonb_build_array(jsonb_build_object('date',now(),'stage',target))
 where id=req.id;
 end if;
 when 'deliver','cancel' then
 select q.* into strict req from ssma_epi.requests q join ssma_epi.regions r on r.id=q.region_id
 where q.id=(p->>'request_id')::uuid and (r.technician_id=actor or (action='cancel' and r.owner_id=actor)) for update of q;
 if req.status<>'Solicitado' then raise exception 'Solicitação já encerrada.'; end if;
 target:='Projeto';
 if action='deliver' and (target is null or target not in ('Projeto','SSMA')) then raise exception 'Confirme o destino do custo.'; end if;
 for line in select * from ssma_epi.lines where request_id=req.id order by material_id loop
 select * into strict mat from ssma_epi.materials where id=line.material_id for update;
 if action='deliver' and (mat.expiry < (now() at time zone 'America/Sao_Paulo')::date or (mat.insulating_glove and (mat.glove_start is null or mat.glove_start > (now() at time zone 'America/Sao_Paulo')::date))) then raise exception 'Material vencido. Cancele a reserva e selecione outro material.'; end if;
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
 if action='names' then
 select coalesce(jsonb_agg(jsonb_build_object('id',e.id,'name',e.title) order by e.title,e.id),'[]') into result
 from public.ssma_records e where e.module='colaboradores' and e.status='Ativo'
 and exists(select 1 from ssma_epi.assignments v where v.employee_id=e.id);
 return result;
 end if;
 select * into emp from public.ssma_records e where e.id=(p->>'employee_id')::uuid and e.module='colaboradores' and e.status='Ativo';
 if emp.id is null then raise exception 'Colaborador indisponível.'; end if;
 if action='states' then return (select coalesce(jsonb_agg(v.state order by v.state),'[]') from ssma_epi.assignments v where v.employee_id=emp.id); end if;
 select * into a from ssma_epi.assignments where employee_id=emp.id and state=p->>'state' for share;
 if a.region_id is null then raise exception 'Vínculo com a regional não encontrado.'; end if;
 select * into strict r from ssma_epi.regions where id=a.region_id and owner_id=emp.owner_id for share;
 select display_name into tech from public.ssma_profiles where user_id=r.technician_id;
 if action='context' then
 return jsonb_build_object('project',a.project,'job',a.job,'technician',tech,'region',r.name,
 'materials',(select coalesce(jsonb_agg(jsonb_build_object('id',m.id,'name',m.name,'ca',m.ca,'size',m.size,'color',m.color,'available',m.qty-m.reserved) order by m.name,m.size),'[]')
 from ssma_epi.materials m where m.region_id=r.id and (not m.insulating_glove or m.glove_start <= (now() at time zone 'America/Sao_Paulo')::date) and m.qty>m.reserved and (m.expiry is null or m.expiry>=(now() at time zone 'America/Sao_Paulo')::date)),
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
 select * into mat from ssma_epi.materials where id=item.id and region_id=r.id and (not insulating_glove or glove_start <= (now() at time zone 'America/Sao_Paulo')::date) for update;
 if mat.id is null or item.qty is null or item.qty<=0 or item.qty>mat.qty-mat.reserved
 or mat.expiry<(now() at time zone 'America/Sao_Paulo')::date then raise exception 'Saldo insuficiente ou material indisponível. Atualize os materiais.'; end if;
 insert into ssma_epi.lines(request_id,material_id,name,ca,size,color,qty) values(req_id,mat.id,mat.name,mat.ca,mat.size,mat.color,item.qty);
 update ssma_epi.materials set reserved=reserved+item.qty where id=mat.id;
 end loop;
 return (select to_jsonb(tracking_code) from ssma_epi.requests where id=req_id);
end $$;
create or replace function ssma_epi.manage(action text,p jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare k text;
begin
 k:=case when action in('entry','material','allocate','glove_date') then 'estoque' when action in('deliver','cancel','progress') then 'solicitacoes'
 when action in('region','assignment') then 'regionais' when action='rule' then 'compras' when action in('asset','test') then 'ensaios' end;
 if k is null or not ssma_epi.allowed('epi.'||k) then raise exception 'Sem permissão para esta operação.'; end if;
 if action='assignment' and not exists(select 1 from ssma_epi.regions r where r.id=(p->>'region_id')::uuid and ssma_epi.request_in_area((p->>'employee_id')::uuid,r.state)) then raise exception 'Colaborador fora da área de atendimento.'; end if;
 if action in ('progress','deliver','cancel','asset','test') and not exists(select 1 from ssma_epi.requests q where q.id=case when action='test' then (select a.request_id from ssma_epi.assets a where a.id=(p->>'asset_id')::uuid) else (p->>'request_id')::uuid end and ssma_epi.request_in_area(q.employee_id,q.state)) then raise exception 'Pedido fora da área de atendimento.'; end if;
 return ssma_epi.manage_owned(action,p);
end $$;

create or replace function ssma_epi.workspace_owned() returns jsonb language sql stable security definer set search_path='' as $$
 with regions as (
 select r.*, p.display_name technician, p.username technician_login from ssma_epi.regions r
 join public.ssma_profiles p on p.user_id=r.technician_id where exists(select 1 from public.ssma_profiles t where t.user_id=auth.uid() and t.active and (t.is_master or (r.state=any(t.coverage) and t.user_id in(r.owner_id,r.technician_id))))
 ), materials as (
 select m.* from ssma_epi.materials m where (m.region_id is null and m.owner_id=auth.uid()) or m.region_id in(select id from regions)
 ), requests as (
 select q.*, coalesce((select jsonb_agg(to_jsonb(l) order by l.name,l.material_id) from ssma_epi.lines l where l.request_id=q.id),'[]') items
 from ssma_epi.requests q where q.region_id in(select id from regions) and ssma_epi.request_in_area(q.employee_id,q.state)
 ), assets as (
 select a.*, coalesce((select jsonb_agg(to_jsonb(t) order by t.id desc) from ssma_epi.tests t where t.asset_id=a.id),'[]') history
 from ssma_epi.assets a where a.request_id in(select id from requests)
 )
 select jsonb_build_object(
 'regions',coalesce((select jsonb_agg(to_jsonb(r) order by r.state,r.name) from regions r),'[]'),
 'assignments',coalesce((select jsonb_agg(to_jsonb(a)||jsonb_build_object('active',e.status='Ativo','employee',e.title)) from ssma_epi.assignments a join public.ssma_records e on e.id=a.employee_id where a.region_id in(select id from regions) and ssma_epi.request_in_area(a.employee_id,a.state)),'[]'),
 'materials',coalesce((select jsonb_agg(to_jsonb(m) order by m.name,m.size,m.color) from materials m),'[]'),
 'requests',coalesce((select jsonb_agg(to_jsonb(q) order by q.created_at desc) from requests q),'[]'),
 'movements',coalesce((select jsonb_agg(to_jsonb(v) order by v.created_at desc) from ssma_epi.movements v where (v.owner_id=auth.uid() or v.region_id in(select id from regions)) and (v.request_id is null or v.request_id in(select id from requests))),'[]'),
 'rules',coalesce((select jsonb_agg(to_jsonb(s)) from ssma_epi.rules s where s.material_id in(select id from materials)),'[]'),
 'assets',coalesce((select jsonb_agg(to_jsonb(a) order by a.due) from assets a),'[]')
 ) where exists(select 1 from public.ssma_profiles where user_id=auth.uid());
$$;



create function ssma_epi.glove_summary(technician uuid) returns jsonb language sql stable security definer set search_path='' as $$
 with actor as (select * from public.ssma_profiles where user_id=auth.uid() and active and ssma_epi.allowed('epi.estoque')),
 areas as (select a.key as region,uf from jsonb_each(ssma_epi.service_areas()) a cross join lateral jsonb_array_elements_text(a.value) uf),
 totals as (select r.state,sum(m.qty) qty,sum(m.qty*m.price) cost,sum(case when m.glove_start is null or m.glove_start > (now() at time zone 'America/Sao_Paulo')::date or m.expiry < (now() at time zone 'America/Sao_Paulo')::date then 0 else m.qty-m.reserved end) available
 from ssma_epi.materials m join ssma_epi.regions r on r.id=m.region_id where m.insulating_glove and (technician is null or r.technician_id=technician)
 group by r.state)
 select coalesce(jsonb_agg(jsonb_build_object('region',a.region,'state',a.uf,'qty',coalesce(t.qty,0),'available',coalesce(t.available,0),'cost',coalesce(t.cost,0)) order by a.region,a.uf),'[]') from areas a cross join actor p left join totals t on t.state=a.uf where (p.is_master or a.uf=any(p.coverage)) and (p.is_master or technician is null or technician=p.user_id)
$$;
create function public.ssma_epi_glove_summary(technician uuid default null) returns jsonb language sql stable security invoker set search_path='' as $$select ssma_epi.glove_summary(technician)$$;
revoke all on function ssma_epi.glove_summary(uuid), public.ssma_epi_glove_summary(uuid) from public,anon,authenticated;
grant execute on function ssma_epi.glove_summary(uuid), public.ssma_epi_glove_summary(uuid) to authenticated;
create or replace function ssma_epi.workspace() returns jsonb language plpgsql stable security definer set search_path='' as $$
declare d jsonb; f boolean:=ssma_epi.allowed('epi.financeiro'); stock boolean:=ssma_epi.allowed('epi.estoque');
 plan boolean:=ssma_epi.allowed('epi.compras'); regions boolean:=ssma_epi.allowed('epi.regionais'); tests boolean:=ssma_epi.allowed('epi.ensaios');
 orders boolean:=ssma_epi.allowed('epi.solicitacoes'); sheet boolean:=ssma_epi.allowed('epi.ficha'); qs jsonb;
begin
 if not (f or stock or plan or regions or tests or orders or sheet) then return null; end if;
 d:=ssma_epi.workspace_owned();
 select coalesce(jsonb_agg(case when f then q else (q-'items')||jsonb_build_object('items',(select jsonb_agg(i-'price') from jsonb_array_elements(q->'items') i)) end),'[]') into qs
 from jsonb_array_elements(d->'requests') q where f or orders or plan or ((sheet or tests) and q->>'status'='Entregue');
 return jsonb_build_object('requests',qs,'regions',d->'regions','movements',case when f then d->'movements' else '[]'::jsonb end,
 'materials',case when stock or plan then d->'materials' when f then (select coalesce(jsonb_agg(jsonb_build_object('id',m->'id','name',m->'name','size',m->'size','color',m->'color','qty',m->'qty','price',m->'price','region_id',m->'region_id')),'[]') from jsonb_array_elements(d->'materials') m) else '[]'::jsonb end,
 'assets',case when tests then d->'assets' else '[]'::jsonb end,'rules',case when plan then d->'rules' else '[]'::jsonb end,
 'assignments',case when regions or plan then d->'assignments' else '[]'::jsonb end);
end $$;

