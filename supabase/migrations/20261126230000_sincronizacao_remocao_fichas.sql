-- =========================================================================================
-- Migração Consolidada: Sincronização Total de Edição, Alteração e Remoção de Fichas / Itens
-- 1. ssma_epi.purge_request: remove definitivamente solicitações/fichas e estorna estoque e financeiro
-- 2. ssma_epi.manage_requests: editar (alterar qtd, excluir e adicionar itens), remover e limpar
-- 3. ssma_epi.sheet: Editar ficha e Excluir ficha sincronizam materiais, linhas, saídas e solicitações
-- 4. Consultas (workspace, indicators, stock_costs, dashboard) garantem exclusão de list_removed
-- 5. Reconciliação imediata de solicitações removidas anteriormente apenas da lista visual
-- =========================================================================================

-- 1. Função utilitária de estorno completo e remoção definitiva de uma ficha/solicitação
CREATE OR REPLACE FUNCTION ssma_epi.purge_request(req_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  q ssma_epi.requests;
  l ssma_epi.lines;
begin
  select * into q from ssma_epi.requests where id = req_id for update;
  if not found then return; end if;

  for l in select * from ssma_epi.lines where request_id = q.id order by material_id loop
    if q.status = 'Solicitado' then
      update ssma_epi.materials
         set reserved = greatest(0, reserved - l.qty)
       where id = l.material_id
         and archived_at is null;
    elsif q.status = 'Entregue' then
      update ssma_epi.materials
         set qty = qty + l.qty
       where id = l.material_id
         and archived_at is null;
    end if;
  end loop;

  delete from ssma_epi.tests
   where asset_id in (select a.id from ssma_epi.assets a where a.request_id = q.id);
  delete from ssma_epi.assets where request_id = q.id;
  delete from ssma_epi.movements where request_id = q.id;
  delete from ssma_epi.sheets where request_id = q.id or id = q.id;
  delete from ssma_epi.sheet_drafts where request_id = q.id;
  delete from ssma_epi.lines where request_id = q.id;
  delete from ssma_epi.requests where id = q.id;
end $function$;

REVOKE ALL ON FUNCTION ssma_epi.purge_request(uuid) FROM public, anon, authenticated;

-- 2. Atualiza ssma_epi.manage_requests (editar qtd / excluir itens / adicionar itens / remover / limpar)
CREATE OR REPLACE FUNCTION ssma_epi.manage_requests(action text, p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  q ssma_epi.requests;
  l ssma_epi.lines;
  mat ssma_epi.materials;
  doc ssma_epi.sheets;
  add_item jsonb;
  removed_ids uuid[];
  kept_count integer;
  added_count integer;
  new_qty integer;
  add_qty integer;
  delta integer;
  count_changed integer := 0;
  rebuilt_items jsonb;
  rebuilt_reasons jsonb;
  today_sp date := (now() at time zone 'America/Sao_Paulo')::date;
begin
  if action not in ('edit_request', 'remove_request', 'clear_requests') then
    raise exception 'Operação inválida em solicitações.';
  end if;
  if not ssma_epi.allowed('epi.solicitacoes') then
    raise exception 'Sem permissão para gerenciar solicitações.' using errcode = '42501';
  end if;

  for q in
    select s.*
      from ssma_epi.requests s
      join ssma_epi.regions r on r.id = s.region_id
     where not s.list_removed
       and ssma_epi.can_use_stock(r)
       and ssma_epi.request_in_area(s.employee_id, s.state)
       and (action = 'clear_requests' or s.id = (p->>'request_id')::uuid)
     order by s.id
     for update of s
  loop
    if action in ('remove_request', 'clear_requests') then
      perform ssma_epi.purge_request(q.id);
      count_changed := count_changed + 1;
      continue;
    end if;

    -- edit_request: altera quantidades, exclui itens e inclui novos materiais
    if length(coalesce(p->>'note', '')) > 500 or length(coalesce(p->>'postal', '')) > 64 then
      raise exception 'Texto de observação ou código de rastreio muito longo.';
    end if;

    removed_ids := coalesce(array(
      select (val)::uuid
        from jsonb_array_elements_text(coalesce(p->'removed_materials', '[]'::jsonb)) as val
       where nullif(trim(val), '') is not null
    ), '{}'::uuid[]);

    added_count := case
      when jsonb_typeof(p->'added_materials') = 'array' then jsonb_array_length(p->'added_materials')
      else 0
    end;

    select count(*) into kept_count
      from ssma_epi.lines x
     where x.request_id = q.id
       and not (x.material_id = any(removed_ids));

    if kept_count + added_count < 1 then
      raise exception 'A ficha precisa manter ao menos 1 item. Para retirar todos os materiais e devolvê-los ao estoque, utilize a opção Remover.';
    end if;

    if q.status = 'Solicitado' then
      for l in select * from ssma_epi.lines where request_id = q.id order by material_id loop
        if l.material_id = any(removed_ids) then
          update ssma_epi.materials
             set reserved = greatest(0, reserved - l.qty)
           where id = l.material_id and archived_at is null;
          delete from ssma_epi.lines where request_id = q.id and material_id = l.material_id;
        else
          new_qty := coalesce((p->'quantities'->>l.material_id::text)::integer, l.qty);
          if new_qty is null or new_qty < 1 then
            raise exception 'Informe uma quantidade válida (mínimo 1) para cada item.';
          end if;
          delta := new_qty - l.qty;
          if delta <> 0 then
            update ssma_epi.materials
               set reserved = greatest(0, reserved + delta)
             where id = l.material_id
               and archived_at is null
               and (delta < 0 or qty - reserved >= delta);
            if not found then
              raise exception 'Saldo disponível insuficiente no estoque para aumentar a quantidade de %.', l.name;
            end if;
            update ssma_epi.lines set qty = new_qty where request_id = q.id and material_id = l.material_id;
          end if;
        end if;
      end loop;

      for add_item in select value from jsonb_array_elements(coalesce(p->'added_materials', '[]'::jsonb)) order by value->>'id' loop
        add_qty := (add_item->>'qty')::integer;
        if add_qty is null or add_qty < 1 then raise exception 'Quantidade inválida para novo item.'; end if;
        select * into mat from ssma_epi.materials m
         where m.id = (add_item->>'id')::uuid and m.region_id = q.region_id and m.archived_at is null
         for update;
        if not found or (mat.qty - mat.reserved) < add_qty
           or (mat.expiry is not null and mat.expiry < today_sp)
           or (mat.insulating_glove and (mat.glove_start is null or mat.glove_start > today_sp)) then
          raise exception 'Saldo insuficiente ou material indisponível para inclusão nesta unidade.';
        end if;
        update ssma_epi.materials set reserved = reserved + add_qty where id = mat.id;
        insert into ssma_epi.lines(request_id, material_id, name, ca, size, color, qty, reason)
        values (q.id, mat.id, mat.name, mat.ca, mat.size, mat.color, add_qty, nullif(trim(coalesce(add_item->>'reason', '')), ''))
        on conflict (request_id, material_id) do update
          set qty = ssma_epi.lines.qty + excluded.qty;
      end loop;

    elsif q.status = 'Entregue' then
      for l in select * from ssma_epi.lines where request_id = q.id order by material_id loop
        select * into strict mat from ssma_epi.materials where id = l.material_id for update;

        if l.material_id = any(removed_ids) then
          update ssma_epi.materials set qty = qty + l.qty where id = mat.id and archived_at is null;
          delete from ssma_epi.tests
           where asset_id in (select a.id from ssma_epi.assets a where a.request_id = q.id and a.material_id = l.material_id);
          delete from ssma_epi.assets where request_id = q.id and material_id = l.material_id;
          delete from ssma_epi.movements where request_id = q.id and material_id = l.material_id and kind = 'Saída';
          delete from ssma_epi.lines where request_id = q.id and material_id = l.material_id;
        else
          new_qty := coalesce((p->'quantities'->>l.material_id::text)::integer, l.qty);
          if new_qty is null or new_qty < 1 then
            raise exception 'Informe uma quantidade válida (mínimo 1) para cada item.';
          end if;
          delta := new_qty - l.qty;
          if delta > 0 then
            if mat.archived_at is not null or (mat.qty - mat.reserved) < delta then
              raise exception 'Saldo disponível insuficiente no estoque para adicionar % unidade(s) de %.', delta, l.name;
            end if;
            update ssma_epi.materials set qty = qty - delta where id = mat.id;
          elsif delta < 0 then
            if (select count(*) from ssma_epi.assets a where a.request_id = q.id and a.material_id = l.material_id) > new_qty then
              raise exception 'Existem equipamentos seriados vinculados acima da nova quantidade informada para %.', l.name;
            end if;
            update ssma_epi.materials set qty = qty + abs(delta) where id = mat.id and archived_at is null;
          end if;

          if delta <> 0 then
            update ssma_epi.lines set qty = new_qty where request_id = q.id and material_id = l.material_id;
            update ssma_epi.movements set qty = new_qty
             where request_id = q.id and material_id = l.material_id and kind = 'Saída';
            if not found then
              insert into ssma_epi.movements(owner_id, region_id, material_id, request_id, kind, qty, price)
              values (q.owner_id, q.region_id, mat.id, q.id, 'Saída', new_qty, coalesce(l.price, mat.price));
            end if;
          end if;
        end if;
      end loop;

      for add_item in select value from jsonb_array_elements(coalesce(p->'added_materials', '[]'::jsonb)) order by value->>'id' loop
        add_qty := (add_item->>'qty')::integer;
        if add_qty is null or add_qty < 1 then raise exception 'Quantidade inválida para novo item.'; end if;
        select * into mat from ssma_epi.materials m
         where m.id = (add_item->>'id')::uuid and m.region_id = q.region_id and m.archived_at is null
         for update;
        if not found or (mat.qty - mat.reserved) < add_qty
           or (mat.expiry is not null and mat.expiry < today_sp)
           or (mat.insulating_glove and (mat.glove_start is null or mat.glove_start > today_sp)) then
          raise exception 'Saldo insuficiente ou material vencido/indisponível para inclusão nesta unidade.';
        end if;
        update ssma_epi.materials set qty = qty - add_qty where id = mat.id;
        insert into ssma_epi.lines(request_id, material_id, name, ca, size, color, qty, price, reason, delivered_glove, glove_due)
        values (
          q.id, mat.id, mat.name, mat.ca, mat.size, mat.color, add_qty, mat.price,
          coalesce(nullif(trim(add_item->>'reason'), ''), 'Inicial'),
          mat.insulating_glove, case when mat.insulating_glove then mat.expiry end
        )
        on conflict (request_id, material_id) do update
          set qty = ssma_epi.lines.qty + excluded.qty;

        update ssma_epi.movements as mov_upd
           set qty = mov_upd.qty + add_qty
         where mov_upd.request_id = q.id and mov_upd.material_id = mat.id and mov_upd.kind = 'Saída';
        if not found then
          insert into ssma_epi.movements(owner_id, region_id, material_id, request_id, kind, qty, price)
          values (q.owner_id, q.region_id, mat.id, q.id, 'Saída', add_qty, mat.price);
        end if;
      end loop;

      for doc in select * from ssma_epi.sheets where request_id = q.id or id = q.id for update loop
        select coalesce(jsonb_agg(jsonb_build_object(
          'key', q.id::text || '/' || l2.material_id::text,
          'date', (coalesce(q.closed_at, q.created_at) at time zone 'America/Sao_Paulo')::date,
          'reason', coalesce(doc.settings->'reasons'->>(q.id::text || '/' || l2.material_id::text), l2.reason, 'Inicial'),
          'ca', l2.ca,
          'equipment', concat_ws(' · ', l2.name, nullif(l2.size, ''), nullif(l2.color, '')),
          'qty', l2.qty, 'state', q.state, 'region_id', q.region_id,
          'employee', q.employee, 'project', q.project, 'job', q.job
        ) order by l2.name, l2.material_id), '[]'::jsonb)
        into rebuilt_items from ssma_epi.lines l2 where l2.request_id = q.id;

        select coalesce(jsonb_object_agg(i->>'key', coalesce(doc.settings->'reasons'->>(i->>'key'), i->>'reason', '')), '{}'::jsonb)
          into rebuilt_reasons from jsonb_array_elements(rebuilt_items) i;

        update ssma_epi.sheets
           set snapshot = jsonb_set(doc.snapshot, '{items}', rebuilt_items),
               settings = jsonb_set(doc.settings, '{reasons}', rebuilt_reasons),
               revision = doc.revision + 1
         where id = doc.id;
      end loop;
    end if;

    update ssma_epi.requests
       set management_note = coalesce(p->>'note', q.management_note),
           postal = upper(trim(coalesce(p->>'postal', q.postal)))
     where id = q.id;
    count_changed := count_changed + 1;
  end loop;

  if count_changed = 0 and action <> 'clear_requests' then
    raise exception 'Solicitação ou ficha indisponível. Atualize a lista.';
  end if;

  return jsonb_build_object('ok', true, 'count', count_changed);
end $function$;

REVOKE ALL ON FUNCTION ssma_epi.manage_requests(text, jsonb) FROM public, anon, authenticated;

-- 3. Atualiza ssma_epi.sheet com suporte completo a Editar Ficha e Excluir Ficha (inclusive fichas legadas sem request_id)
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
 linked_req ssma_epi.requests;
 orphan_req_id uuid;
 legacy_req_id uuid;
 draft_payload jsonb;
 kept jsonb; added jsonb; line jsonb; material ssma_epi.materials; doc_qty integer;
 e public.ssma_records;
 doc ssma_epi.sheets;
 snap jsonb; opts jsonb; list jsonb; template jsonb; items jsonb; org text;
 req_line record;
 next_signed boolean;
 line_key text;
 target_qty integer;
 qty_delta integer;
 item_reason text;
 snap_item jsonb;
 mat_uuid uuid;
 req_uuid uuid;
 target_unit_id uuid;
 today_sp date := (now() at time zone 'America/Sao_Paulo')::date;
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
   return (select coalesce(jsonb_agg(jsonb_build_object('id',s.id,'employee_id',s.employee_id,'number',s.number,'issued_at',s.issued_at,'signed',s.signed) order by s.number desc),'[]')
     from ssma_epi.sheets s where master and s.expires_at>now() and not exists(select 1 from public.ssma_records e1 where e1.id=s.employee_id));
 end if;
 if action='employees' then
   return (select coalesce(jsonb_agg(jsonb_build_object('id',e1.id,'name',e1.title,'project',e1.unit) order by e1.title,e1.id),'[]')
     from public.ssma_records e1 where e1.module='colaboradores' and ssma_epi.record_area(e1));
 end if;
 select x.* into e from public.ssma_records x where x.id=emp and x.module='colaboradores' and ssma_epi.record_area(x) for share;
 if e.id is null and not (master and action in ('open','edit','delete','toggle_signed') and exists(
   select 1 from ssma_epi.sheets s where s.id=(p->>'id')::uuid and s.employee_id=emp and s.expires_at>now())) then
   raise exception 'Colaborador fora da área de atendimento.' using errcode='42501';
 end if;
 if action='toggle_signed' then
   select s.* into doc from ssma_epi.sheets s where s.id=(p->>'id')::uuid and s.employee_id=emp
    and (master or (s.author=actor and not exists(
      select 1 from jsonb_array_elements(s.snapshot->'items') i
      where not exists(select 1 from ssma_epi.regions r where r.id=(i->>'region_id')::uuid
        and ssma_epi.can_use_stock(r) and ssma_epi.request_in_area(emp,i->>'state'))))) for update;
   if doc.id is null then raise exception 'Ficha indisponível.'; end if;
   next_signed := coalesce((p->>'signed')::boolean, not doc.signed);
   update ssma_epi.sheets set signed=next_signed, signed_at=case when next_signed then now() else null end where id=doc.id returning * into doc;
   update ssma_epi.requests set sheet_signed=doc.signed, sheet_signed_at=doc.signed_at where id in (doc.id, doc.request_id);
   return to_jsonb(doc);
 end if;
 if source_id is not null and action in ('issue','context','draft') then
   select q.* into source from ssma_epi.requests q join ssma_epi.regions r on r.id=q.region_id
    where q.id=source_id and not q.list_removed and q.employee_id=emp and q.status<>'Cancelado' and ssma_epi.can_use_stock(r) and ssma_epi.request_in_area(emp,q.state) for update of q;
   if not found then raise exception 'Solicitação indisponível.'; end if;
   select payload into draft_payload from ssma_epi.sheet_drafts where request_id=source_id and employee_id=emp;
   select * into doc from ssma_epi.sheets where request_id=source_id or id=source_id limit 1;
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
     -- Remove solicitações vinculadas diretamente (doc.id ou doc.request_id) e devolve tudo ao estoque
     for orphan_req_id in
       select id from ssma_epi.requests where id in (doc.id, doc.request_id)
     loop
       perform ssma_epi.purge_request(orphan_req_id);
     end loop;

     -- Remove também eventuais solicitações legadas referenciadas em doc.snapshot->'items' caso nenhuma outra ficha dependa delas
     for legacy_req_id in
       select distinct split_part(it->>'key', '/', 1)::uuid
         from jsonb_array_elements(coalesce(doc.snapshot->'items', '[]'::jsonb)) it
        where (it->>'key') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/'
     loop
       if exists (select 1 from ssma_epi.requests q where q.id = legacy_req_id and q.employee_id = doc.employee_id)
          and not exists (
            select 1 from ssma_epi.sheets s2
             where s2.id <> doc.id
               and (s2.request_id = legacy_req_id or s2.id = legacy_req_id
                 or exists (
                   select 1 from jsonb_array_elements(coalesce(s2.snapshot->'items', '[]'::jsonb)) it2
                    where it2->>'key' like legacy_req_id::text || '/%'
                 ))
          ) then
         perform ssma_epi.purge_request(legacy_req_id);
       end if;
     end loop;

     delete from ssma_epi.sheets where id=doc.id;
     return jsonb_build_object('ok',true);
   end if;
   snap:=doc.snapshot;
 elsif action in ('context','issue','draft') then
   if source_id is not null then
     select coalesce(jsonb_agg(jsonb_build_object('key',q.id::text||'/'||l.material_id::text,'date',(coalesce(q.closed_at,q.created_at) at time zone 'America/Sao_Paulo')::date,
       'reason',l.reason,'ca',l.ca,'equipment',concat_ws(' · ',l.name,nullif(l.size,''),nullif(l.color,'')),'qty',l.qty,
       'state',q.state,'region_id',q.region_id,'employee',q.employee,'project',q.project,'job',q.job) order by q.closed_at,q.id,l.name,l.material_id),'[]') into items
     from ssma_epi.requests q join ssma_epi.lines l on l.request_id=q.id join ssma_epi.regions r on r.id=q.region_id
     where q.employee_id=emp and q.id=source_id and not q.list_removed and ssma_epi.can_use_stock(r) and ssma_epi.request_in_area(emp,q.state);
   elsif action='issue' and nullif(p->>'id','') is not null and exists(select 1 from ssma_epi.lines where request_id=(p->>'id')::uuid) then
     select coalesce(jsonb_agg(jsonb_build_object('key',q.id::text||'/'||l.material_id::text,'date',(coalesce(q.closed_at,q.created_at) at time zone 'America/Sao_Paulo')::date,
       'reason',l.reason,'ca',l.ca,'equipment',concat_ws(' · ',l.name,nullif(l.size,''),nullif(l.color,'')),'qty',l.qty,
       'state',q.state,'region_id',q.region_id,'employee',q.employee,'project',q.project,'job',q.job) order by q.closed_at,q.id,l.name,l.material_id),'[]') into items
     from ssma_epi.requests q join ssma_epi.lines l on l.request_id=q.id join ssma_epi.regions r on r.id=q.region_id
     where q.employee_id=emp and q.id=(p->>'id')::uuid and not q.list_removed and ssma_epi.can_use_stock(r) and ssma_epi.request_in_area(emp,q.state);
   else
     items:='[]'::jsonb;
   end if;
   snap:=jsonb_build_object('name',e.title,'unit',e.unit,
     'job',e.details->>'extra','company',e.details->>'company','sector',e.details->>'sector',
     'cnpj',e.details->>'cnpj','registration',e.details->>'registration','cpf',e.details->>'cpf','items',items);
 else raise exception 'Operação inválida.'; end if;

 org:=coalesce(nullif(upper(regexp_replace(snap->>'cnpj','[^a-zA-Z0-9]','','g')),''),nullif(lower(trim(snap->>'company')),''));
 if action='context' then
   select coalesce(jsonb_agg(jsonb_build_object('id',s.id,'number',s.number,'issued_at',s.issued_at,'signed',s.signed,'signed_at',s.signed_at) order by s.number desc),'[]') into list
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

 if action='edit' then
   select q.* into linked_req from ssma_epi.requests q
    where q.id in (doc.id, doc.request_id)
    limit 1
    for update;
   if linked_req.id is null then
     -- Fallback para fichas legadas cujos itens apontam para req_id no snapshot
     select q.* into linked_req
       from ssma_epi.requests q
      where q.employee_id = emp
        and q.id in (
          select split_part(it->>'key', '/', 1)::uuid
            from jsonb_array_elements(coalesce(doc.snapshot->'items', '[]'::jsonb)) it
           where (it->>'key') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/'
        )
      order by q.created_at desc
      limit 1
      for update;
   end if;
   if linked_req.id is not null then
     opts:=jsonb_set(opts,'{identity,unit}',snap->'unit');
   end if;
 end if;

 if action='issue' and source.status='Solicitado' then
   for line in select to_jsonb(l) from ssma_epi.lines l where l.request_id=source_id order by l.material_id loop
     if coalesce(p->'removed','[]') ? (source_id::text||'/'||(line->>'material_id')) then
       update ssma_epi.materials set reserved=greatest(0,reserved-(line->>'qty')::int) where id=(line->>'material_id')::uuid and archived_at is null;
       delete from ssma_epi.lines where request_id=source_id and material_id=(line->>'material_id')::uuid;
     end if;
   end loop;
   for line in select value from jsonb_array_elements(coalesce(p->'document_items','[]')) order by value->>'id' loop
     doc_qty:=(line->>'qty')::int;
     if doc_qty is null or doc_qty<1 or coalesce(line->>'reason','') not in ('Inicial','Substituição por perda ou roubo','Substituição por período de troca/desgaste') then raise exception 'Confira a quantidade e o motivo.'; end if;
     update ssma_epi.materials set reserved=reserved+qty_requested.n from (select (line->>'qty')::int n) qty_requested
       where id=(line->>'id')::uuid and region_id=source.region_id and archived_at is null and ssma_epi.materials.qty-reserved>=qty_requested.n returning ssma_epi.materials.* into material;
     if not found then raise exception 'Saldo insuficiente ou material indisponível.'; end if;
     insert into ssma_epi.lines(request_id,material_id,name,ca,size,color,qty,price,reason) values(source_id,material.id,material.name,material.ca,material.size,material.color,doc_qty,material.price,line->>'reason')
       on conflict(request_id,material_id) do update set qty=ssma_epi.lines.qty+excluded.qty,reason=excluded.reason;
   end loop;
   if not exists(select 1 from ssma_epi.lines where request_id=source_id) then raise exception 'Inclua pelo menos um EPI.'; end if;
   perform ssma_epi.manage('deliver',jsonb_build_object('request_id',source_id));
   snap:=ssma_epi.sheet('context',p)->'snapshot';
   opts:=jsonb_set(opts,'{reasons}',(select coalesce(jsonb_object_agg(i->>'key',coalesce(opts->'reasons'->>(i->>'key'),i->>'reason','')),'{}') from jsonb_array_elements(snap->'items') i));

 elsif action='edit' and (linked_req.id is not null or jsonb_array_length(coalesce(p->'document_items','[]'::jsonb)) > 0) then
   -- Sincroniza todas as linhas referenciadas pelos itens da ficha (mesmo em fichas multi-solicitação)
   for snap_item in select value from jsonb_array_elements(coalesce(snap->'items', '[]'::jsonb)) loop
     line_key := snap_item->>'key';
     if line_key ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
       req_uuid := split_part(line_key, '/', 1)::uuid;
       mat_uuid := split_part(line_key, '/', 2)::uuid;
       select l.*, q.status as req_status, q.owner_id as req_owner_id, q.region_id as req_region_id
         into req_line
         from ssma_epi.lines l
         join ssma_epi.requests q on q.id = l.request_id
        where l.request_id = req_uuid and l.material_id = mat_uuid and q.employee_id = emp;

       if found then
         select * into strict material from ssma_epi.materials where id = req_line.material_id for update;
         if coalesce(p->'removed', '[]'::jsonb) ? line_key then
           if req_line.req_status = 'Entregue' then
             update ssma_epi.materials as m set qty = m.qty + req_line.qty where m.id = material.id and m.archived_at is null;
             delete from ssma_epi.tests where asset_id in (select a.id from ssma_epi.assets a where a.request_id = req_uuid and a.material_id = mat_uuid);
             delete from ssma_epi.assets where request_id = req_uuid and material_id = mat_uuid;
             delete from ssma_epi.movements where request_id = req_uuid and material_id = mat_uuid and kind = 'Saída';
           elsif req_line.req_status = 'Solicitado' then
             update ssma_epi.materials as m set reserved = greatest(0, m.reserved - req_line.qty) where m.id = material.id and m.archived_at is null;
           end if;
           delete from ssma_epi.lines where request_id = req_uuid and material_id = mat_uuid;
           if not exists (select 1 from ssma_epi.lines where request_id = req_uuid)
              and req_uuid is distinct from coalesce(linked_req.id, doc.id) then
             delete from ssma_epi.sheet_drafts where request_id = req_uuid;
             delete from ssma_epi.requests where id = req_uuid;
           end if;
         else
           target_qty := coalesce(
             nullif(p->'item_quantities'->>line_key, '')::integer,
             nullif(p->'item_quantities'->>mat_uuid::text, '')::integer,
             req_line.qty
           );
           if target_qty < 1 or target_qty > 1000000 then
             raise exception 'Informe uma quantidade válida (mínimo 1) para %.', req_line.name;
           end if;
           qty_delta := target_qty - req_line.qty;
           if req_line.req_status = 'Entregue' then
             if qty_delta > 0 then
               if material.archived_at is not null or (material.qty - material.reserved) < qty_delta then
                 raise exception 'Saldo insuficiente no estoque para adicionar % unidade(s) de %.', qty_delta, req_line.name;
               end if;
               update ssma_epi.materials as m set qty = m.qty - qty_delta where m.id = material.id;
             elsif qty_delta < 0 then
               if (select count(*) from ssma_epi.assets a where a.request_id = req_uuid and a.material_id = mat_uuid) > target_qty then
                 raise exception 'Existem equipamentos seriados vinculados acima da nova quantidade informada para %.', req_line.name;
               end if;
               update ssma_epi.materials as m set qty = m.qty + abs(qty_delta) where m.id = material.id and m.archived_at is null;
             end if;
           elsif req_line.req_status = 'Solicitado' then
             if qty_delta > 0 then
               if material.archived_at is not null or (material.qty - material.reserved) < qty_delta then
                 raise exception 'Saldo disponível insuficiente para aumentar %.', req_line.name;
               end if;
               update ssma_epi.materials as m set reserved = m.reserved + qty_delta where m.id = material.id;
             elsif qty_delta < 0 then
               update ssma_epi.materials as m set reserved = greatest(0, m.reserved + qty_delta) where m.id = material.id and m.archived_at is null;
             end if;
           end if;

           item_reason := coalesce(nullif(opts->'reasons'->>line_key, ''), req_line.reason);
           update ssma_epi.lines set qty = target_qty, reason = item_reason
            where request_id = req_uuid and material_id = mat_uuid;

           if qty_delta <> 0 and req_line.req_status = 'Entregue' then
             update ssma_epi.movements set qty = target_qty
              where request_id = req_uuid and material_id = mat_uuid and kind = 'Saída';
             if not found then
               insert into ssma_epi.movements(owner_id, region_id, material_id, request_id, kind, qty, price)
               values (req_line.req_owner_id, req_line.req_region_id, material.id, req_uuid, 'Saída', target_qty, coalesce(req_line.price, material.price));
             end if;
           end if;
         end if;
       end if;
     end if;
   end loop;

   -- Novos itens adicionados durante a edição criam/integram entrega e abatem o saldo do estoque
   if jsonb_array_length(coalesce(p->'document_items','[]'::jsonb)) > 0 then
     if linked_req.id is null then
       if not exists (select 1 from ssma_epi.requests where id = doc.id) then
         perform ssma_epi.sheet_delivery(e, doc.id, p->'document_items');
       end if;
       select * into linked_req from ssma_epi.requests where id = doc.id;
     else
       target_unit_id := linked_req.region_id;
       for line in select value from jsonb_array_elements(coalesce(p->'document_items','[]'::jsonb)) order by value->>'id' loop
         doc_qty := (line->>'qty')::integer;
         if doc_qty is null or doc_qty < 1 or doc_qty > 1000000 then raise exception 'Quantidade inválida.'; end if;
         select m.* into material from ssma_epi.materials m join ssma_epi.regions r on r.id = m.region_id
           where m.id = (line->>'id')::uuid and m.archived_at is null and ssma_epi.can_use_stock(r)
             and m.region_id = target_unit_id
             and (m.expiry is null or m.expiry >= today_sp)
             and (not m.insulating_glove or (m.glove_start is not null and today_sp between m.glove_start and m.glove_start + 365))
           for update of m;
         if not found or (material.qty - material.reserved) < doc_qty then
           raise exception 'Saldo insuficiente ou material indisponível nesta unidade.';
         end if;
         if linked_req.status = 'Solicitado' then
           update ssma_epi.materials as m_upd set reserved = m_upd.reserved + doc_qty where m_upd.id = material.id;
         else
           update ssma_epi.materials as m_upd set qty = m_upd.qty - doc_qty where m_upd.id = material.id;
         end if;
         insert into ssma_epi.lines(request_id, material_id, name, ca, size, color, qty, price, reason, delivered_glove, glove_due)
         values (
           linked_req.id, material.id, material.name, material.ca, material.size, material.color, doc_qty, material.price,
           coalesce(nullif(line->>'reason', ''), 'Inicial'), material.insulating_glove, case when material.insulating_glove then material.expiry end
         )
         on conflict (request_id, material_id) do update
           set qty = ssma_epi.lines.qty + excluded.qty,
               reason = excluded.reason;

         if linked_req.status = 'Entregue' then
           update ssma_epi.movements as mov_upd
              set qty = mov_upd.qty + doc_qty
            where mov_upd.request_id = linked_req.id and mov_upd.material_id = material.id and mov_upd.kind = 'Saída';
           if not found then
             insert into ssma_epi.movements(owner_id, region_id, material_id, request_id, kind, qty, price)
             values (linked_req.owner_id, linked_req.region_id, material.id, linked_req.id, 'Saída', doc_qty, material.price);
           end if;
         end if;
       end loop;
     end if;
   end if;

   -- Reconstrói os itens do snapshot com as quantidades atualizadas das linhas existentes (ou JSON para linhas sem request)
   select coalesce(jsonb_agg(item_obj order by ord_idx), '[]'::jsonb)
     into kept
     from (
       select t.ord as ord_idx,
         case
           when l2.request_id is not null then jsonb_build_object(
             'key', l2.request_id::text || '/' || l2.material_id::text,
             'date', (coalesce(q2.closed_at, q2.created_at) at time zone 'America/Sao_Paulo')::date,
             'reason', coalesce(nullif(opts->'reasons'->>(l2.request_id::text || '/' || l2.material_id::text), ''), l2.reason, t.i->>'reason', 'Inicial'),
             'ca', l2.ca,
             'equipment', concat_ws(' · ', l2.name, nullif(l2.size, ''), nullif(l2.color, '')),
             'qty', l2.qty,
             'state', q2.state,
             'region_id', q2.region_id,
             'employee', q2.employee,
             'project', q2.project,
             'job', q2.job
           )
           when (p->'item_quantities') ? (t.i->>'key') then jsonb_set(t.i, '{qty}', to_jsonb(greatest(1, (p->'item_quantities'->>(t.i->>'key'))::int)))
           else t.i
         end as item_obj
       from jsonb_array_elements(coalesce(snap->'items', '[]'::jsonb)) with ordinality t(i, ord)
       left join ssma_epi.lines l2
         on (t.i->>'key') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        and l2.request_id = split_part(t.i->>'key', '/', 1)::uuid
        and l2.material_id = split_part(t.i->>'key', '/', 2)::uuid
       left join ssma_epi.requests q2 on q2.id = l2.request_id
       where not (coalesce(p->'removed', '[]'::jsonb) ? (t.i->>'key'))
     ) sub;

   if linked_req.id is not null then
     select coalesce(jsonb_agg(jsonb_build_object(
       'key', linked_req.id::text || '/' || l_extra.material_id::text,
       'date', (coalesce(linked_req.closed_at, linked_req.created_at) at time zone 'America/Sao_Paulo')::date,
       'reason', l_extra.reason,
       'ca', l_extra.ca,
       'equipment', concat_ws(' · ', l_extra.name, nullif(l_extra.size, ''), nullif(l_extra.color, '')),
       'qty', l_extra.qty,
       'state', linked_req.state,
       'region_id', linked_req.region_id,
       'employee', linked_req.employee,
       'project', linked_req.project,
       'job', linked_req.job
     ) order by l_extra.name, l_extra.material_id), '[]'::jsonb)
     into added
     from ssma_epi.lines l_extra
     where l_extra.request_id = linked_req.id
       and not exists (
         select 1 from jsonb_array_elements(kept) k_item
          where k_item->>'key' = linked_req.id::text || '/' || l_extra.material_id::text
       );
     kept := kept || added;
   end if;

   if jsonb_array_length(kept) = 0 then
     raise exception 'Mantenha ao menos 1 EPI na ficha ou utilize a opção Excluir ficha.';
   end if;

   snap := jsonb_set(snap, '{items}', kept);
   opts := jsonb_set(opts, '{reasons}', (
     select coalesce(jsonb_object_agg(i->>'key', coalesce(opts->'reasons'->>(i->>'key'), i->>'reason', '')), '{}'::jsonb)
     from jsonb_array_elements(snap->'items') i
   ));

 elsif action='edit' or source_id is not null then
   select coalesce(jsonb_agg(
     case
       when (p->'item_quantities') ? (i->>'key') then jsonb_set(i, '{qty}', to_jsonb(greatest(1, (p->'item_quantities'->>(i->>'key'))::int)))
       else i
     end
     order by ord
   ),'[]') into kept
   from jsonb_array_elements(snap->'items') with ordinality t(i,ord)
   where not (coalesce(p->'removed','[]') ? (i->>'key'));

   added:='[]';
   for line in select value from jsonb_array_elements(coalesce(p->'document_items','[]')) loop
     doc_qty:=(line->>'qty')::integer;
     if doc_qty is null or doc_qty<1 or doc_qty>1000000 then raise exception 'Quantidade inválida.'; end if;
     select m.* into material from ssma_epi.materials m join ssma_epi.regions r on r.id=m.region_id
       where m.id=(line->>'id')::uuid and m.archived_at is null and ssma_epi.can_use_stock(r)
       and m.region_id=coalesce(source.region_id,ssma_epi.employee_unit(e));
     if not found then raise exception 'Material indisponível nesta unidade.'; end if;
     added:=added||jsonb_build_array(jsonb_build_object('key',gen_random_uuid(),'ca',material.ca,'qty',doc_qty,'equipment',concat_ws(' · ',material.name,nullif(material.size,''),nullif(material.color,'')),
       'date',today_sp,'state',e.employee_state,'region_id',material.region_id,'reason',line->>'reason'));
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
   insert into ssma_epi.sheets(id,employee_id,author,snapshot,settings,issue_hash,request_id,signed,signed_at)
   values((p->>'id')::uuid,emp,actor,snap,opts,md5(p::text),source_id,coalesce(source.sheet_signed,false),source.sheet_signed_at)
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

-- 4. Consultas consolidadas sempre ignoram registros removidos (list_removed)
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
     and q.status='Entregue' and q.destination='Projeto' and not q.list_removed
   group by q.project,q.state,l.ca,case when trim(l.ca)='' then l.name end
 ) z
$function$;

CREATE OR REPLACE FUNCTION ssma_epi.dashboard_owned()
 RETURNS table(id uuid, title text, unit text, status text, event_date date)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
 select q.id, 'Pedido de EPI · '||q.employee, q.project, case q.status when 'Entregue' then 'Concluído' when 'Cancelado' then 'Inativo' else 'Pendente' end,
 (q.created_at at time zone 'America/Sao_Paulo')::date from ssma_epi.requests q join ssma_epi.regions r on r.id=q.region_id
 where ssma_epi.can_use_stock(r) and ssma_epi.request_in_area(q.employee_id,q.state) and not q.list_removed
$function$;

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
   exists(select 1 from ssma_epi.sheets s where s.request_id=q.id or s.id=q.id) as has_sheet,
   coalesce((select jsonb_agg(to_jsonb(l) order by l.name,l.material_id) from ssma_epi.lines l where l.request_id=q.id),'[]') items
 from ssma_epi.requests q left join public.ssma_records registered on registered.id=q.employee_id and registered.module='colaboradores'
 where not q.list_removed and q.region_id in(select id from regions) and ssma_epi.request_in_area(q.employee_id,q.state)
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

DO $patch_indicators$
declare
  definition text := pg_get_functiondef('ssma_epi.indicators_overview(jsonb)'::regprocedure);
begin
  if strpos(definition, 'and not q.list_removed') = 0 then
    definition := replace(
      definition,
      'where q.region_id in (select id from scoped_regions)',
      'where not q.list_removed and q.region_id in (select id from scoped_regions)'
    );
    execute definition;
  end if;
end $patch_indicators$;

-- 5. Reconciliação única: fichas/solicitações que haviam sido removidas apenas da lista
--    são excluídas de fato, estornando itens ao estoque e apagando movimentações de saída.
DO $reconcile$
declare
  rid uuid;
begin
  for rid in
    select id from ssma_epi.requests
     where list_removed and employee <> 'Colaborador removido'
     order by id
  loop
    perform ssma_epi.purge_request(rid);
  end loop;
end $reconcile$;
