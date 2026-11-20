alter table ssma_epi.materials add column stock_center text not null default '';

create or replace function ssma_epi.manage(action text, p jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
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
 insert into ssma_epi.materials(id,owner_id,region_id,stock_center,name,ca,no_ca,price,qty,minimum,expiry,size,color)
 values((p->>'id')::uuid,actor,reg.id,trim(coalesce(p->>'stock_center','')),trim(p->>'name'),trim(coalesce(p->>'ca','')),coalesce((p->>'no_ca')::boolean,false),
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

create or replace function ssma_epi.portal(action text, p jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
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
 from ssma_epi.materials m where m.region_id=r.id and (m.stock_center='' or lower(m.stock_center)=lower(a.center)) and m.qty>m.reserved and (m.expiry is null or m.expiry>=(now() at time zone 'America/Sao_Paulo')::date)),
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
 select * into mat from ssma_epi.materials where id=item.id and region_id=r.id and (stock_center='' or lower(stock_center)=lower(a.center)) for update;
 if mat.id is null or item.qty is null or item.qty<=0 or item.qty>mat.qty-mat.reserved
 or mat.expiry<(now() at time zone 'America/Sao_Paulo')::date then raise exception 'Saldo insuficiente ou material indisponível. Atualize os materiais.'; end if;
 insert into ssma_epi.lines(request_id,material_id,name,ca,size,color,qty) values(req_id,mat.id,mat.name,mat.ca,mat.size,mat.color,item.qty);
 update ssma_epi.materials set reserved=reserved+item.qty where id=mat.id;
 end loop;
 return to_jsonb(req_id);
end $$;
