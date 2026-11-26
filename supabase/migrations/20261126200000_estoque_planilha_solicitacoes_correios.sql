-- =========================================================================================
-- Migração Consolidada:
-- 1. Importação de Estoque por Planilha (staging temporário com exclusão automática + logs)
-- 2. Novos Status de Solicitações (Para Aprovação do Gestor, Em Separação, Enviada, Concluída)
-- 3. Correios com CEP, Tipo (Colaborador, Fornecedor, Outros) e Alocação de Custo ao Projeto
-- =========================================================================================

-- 1. Tabelas privadas de staging temporário de planilha e log detalhado de importação
CREATE TABLE IF NOT EXISTS ssma_epi.stock_import_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES public.ssma_profiles(user_id) ON DELETE CASCADE,
  region_id uuid NOT NULL REFERENCES ssma_epi.regions(id) ON DELETE CASCADE,
  file_name text NOT NULL CHECK (length(trim(file_name)) BETWEEN 1 AND 260),
  byte_size integer NOT NULL DEFAULT 0 CHECK (byte_size >= 0),
  raw_payload text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE ssma_epi.stock_import_files ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ssma_epi.stock_import_files FROM public, anon, authenticated;
CREATE INDEX IF NOT EXISTS epi_stock_import_files_created_idx ON ssma_epi.stock_import_files(created_at);

CREATE TABLE IF NOT EXISTS ssma_epi.stock_import_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES public.ssma_profiles(user_id) ON DELETE CASCADE,
  actor_name text NOT NULL DEFAULT '',
  region_id uuid NOT NULL REFERENCES ssma_epi.regions(id) ON DELETE CASCADE,
  unit_name text NOT NULL DEFAULT '',
  file_name text NOT NULL DEFAULT '',
  total_rows integer NOT NULL DEFAULT 0,
  created_count integer NOT NULL DEFAULT 0,
  updated_count integer NOT NULL DEFAULT 0,
  unchanged_count integer NOT NULL DEFAULT 0,
  error_count integer NOT NULL DEFAULT 0,
  file_deleted boolean NOT NULL DEFAULT true,
  entries jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE ssma_epi.stock_import_logs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ssma_epi.stock_import_logs FROM public, anon, authenticated;
CREATE INDEX IF NOT EXISTS epi_stock_import_logs_region_idx ON ssma_epi.stock_import_logs(region_id, created_at DESC);

-- 2. Atualização de status/etapas na Gestão de Solicitações
ALTER TABLE ssma_epi.requests ALTER COLUMN stage SET DEFAULT 'Para Aprovação do Gestor';

UPDATE ssma_epi.requests
   SET stage = CASE
     WHEN status = 'Entregue' THEN 'Concluída'
     WHEN stage IN ('Pedido recebido', 'Aguardando aprovação do projeto') THEN 'Para Aprovação do Gestor'
     WHEN stage IN ('Pedido separado', 'Pronto para retirada na base') THEN 'Em Separação'
     WHEN stage = 'Enviado pelos Correios' THEN 'Enviada'
     ELSE stage
   END
 WHERE (status = 'Entregue' AND stage <> 'Concluída')
    OR (status = 'Solicitado' AND stage IN ('Pedido recebido', 'Aguardando aprovação do projeto', 'Pedido separado', 'Pronto para retirada na base', 'Enviado pelos Correios'));

CREATE INDEX IF NOT EXISTS epi_requests_stage_status_idx ON ssma_epi.requests(status, stage) WHERE NOT list_removed;

-- 3. Correios: CEP, Tipo de Destinatário (Colaborador / Fornecedor / Outros) e Custo no Projeto
ALTER TABLE ssma_epi.shipments
  ADD COLUMN IF NOT EXISTS cep text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS recipient_type text NOT NULL DEFAULT 'Colaborador'
    CHECK (recipient_type IN ('Colaborador', 'Fornecedor', 'Outros')),
  ADD COLUMN IF NOT EXISTS charge_project boolean NOT NULL DEFAULT false;

UPDATE ssma_epi.shipments
   SET recipient_type = CASE WHEN employee_id IS NOT NULL THEN 'Colaborador' ELSE 'Outros' END,
       charge_project = (project NOT IN ('SSMA', 'Setor Facilities'))
 WHERE cep = '' AND charge_project = false AND (employee_id IS NULL OR project NOT IN ('SSMA', 'Setor Facilities'));

-- Função auxiliar para resolver UF a partir do CEP brasileiro de 8 dígitos
CREATE OR REPLACE FUNCTION ssma_epi.cep_uf(raw_cep text)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO ''
AS $function$
declare
  digits text := regexp_replace(coalesce(raw_cep, ''), '[^0-9]', '', 'g');
  n integer;
begin
  if length(digits) <> 8 then return null; end if;
  n := digits::integer;
  if n between 1000000 and 19999999 then return 'SP';
  elsif n between 20000000 and 28999999 then return 'RJ';
  elsif n between 29000000 and 29999999 then return 'ES';
  elsif n between 30000000 and 39999999 then return 'MG';
  elsif n between 40000000 and 48999999 then return 'BA';
  elsif n between 49000000 and 49999999 then return 'SE';
  elsif n between 50000000 and 56999999 then return 'PE';
  elsif n between 57000000 and 57999999 then return 'AL';
  elsif n between 58000000 and 58999999 then return 'PB';
  elsif n between 59000000 and 59999999 then return 'RN';
  elsif n between 60000000 and 63999999 then return 'CE';
  elsif n between 64000000 and 64999999 then return 'PI';
  elsif n between 65000000 and 65999999 then return 'MA';
  elsif n between 66000000 and 68899999 then return 'PA';
  elsif n between 68900000 and 68999999 then return 'AP';
  elsif n between 69000000 and 69299999 then return 'AM';
  elsif n between 69300000 and 69399999 then return 'RR';
  elsif n between 69400000 and 69899999 then return 'AM';
  elsif n between 69900000 and 69999999 then return 'AC';
  elsif n between 70000000 and 72799999 then return 'DF';
  elsif n between 72800000 and 72999999 then return 'GO';
  elsif n between 73000000 and 73699999 then return 'DF';
  elsif n between 73700000 and 76799999 then return 'GO';
  elsif n between 76800000 and 76999999 then return 'RO';
  elsif n between 77000000 and 77999999 then return 'TO';
  elsif n between 78000000 and 78899999 then return 'MT';
  elsif n between 79000000 and 79999999 then return 'MS';
  elsif n between 80000000 and 87999999 then return 'PR';
  elsif n between 88000000 and 89999999 then return 'SC';
  elsif n between 90000000 and 99999999 then return 'RS';
  end if;
  return null;
end $function$;
REVOKE ALL ON FUNCTION ssma_epi.cep_uf(text) FROM public, anon, authenticated;

-- 4. Função interna de processamento de lote de importação de planilha (com isolamento por estoque e sem duplicar itens)
CREATE OR REPLACE FUNCTION ssma_epi.import_stock_rows(dest uuid, p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  actor public.ssma_profiles;
  reg ssma_epi.regions;
  item jsonb;
  existing ssma_epi.materials;
  created_mat ssma_epi.materials;
  results jsonb := '[]'::jsonb;
  row_line integer;
  row_name text;
  row_ca text;
  row_no_ca boolean;
  row_price numeric(14,2);
  row_qty integer;
  row_min integer;
  row_size text;
  row_color text;
  row_generics text[];
  is_glove boolean;
  today_sp date := (now() at time zone 'America/Sao_Paulo')::date;
  remove_qty integer;
  add_qty integer;
  changed_fields text[];
  note_suffix text;
begin
  if not ssma_epi.allowed('epi.estoque') then
    raise exception 'Sem permissão de estoque.' using errcode = '42501';
  end if;
  select * into strict actor from public.ssma_profiles where user_id = auth.uid() and active;
  select r.* into reg from ssma_epi.regions r
   where r.id = dest and (r.distribution_unit is not null or r.individual) and ssma_epi.can_use_stock(r);
  if reg.id is null then
    raise exception 'Estoque de destino não autorizado para o seu usuário.' using errcode = '42501';
  end if;

  if jsonb_typeof(p->'rows') is distinct from 'array' then
    raise exception 'Formato de linhas de importação inválido.';
  end if;

  for item in select value from jsonb_array_elements(p->'rows') loop
    row_line := coalesce((item->>'line')::int, 0);
    row_name := trim(coalesce(item->>'name', ''));
    row_no_ca := coalesce((item->>'no_ca')::boolean, false);
    row_ca := case when row_no_ca then '' else regexp_replace(trim(coalesce(item->>'ca', '')), '[^0-9]', '', 'g') end;
    row_size := trim(coalesce(item->>'size', ''));
    row_color := trim(coalesce(item->>'color', ''));

    begin
      if row_name = '' or length(row_name) > 200 then
        raise exception 'Informe um nome de material válido (até 200 caracteres).';
      end if;
      if not row_no_ca and row_ca = '' then
        raise exception 'Informe o CA principal numérico ou "Sem CA".';
      end if;

      row_price := round(coalesce((item->>'price')::numeric, 0), 2);
      row_qty := coalesce((item->>'qty')::integer, 0);
      row_min := coalesce((item->>'minimum')::integer, 0);

      if row_price < 0 or row_qty < 0 or row_min < 0 then
        raise exception 'Valores de preço, quantidade e mínimo não podem ser negativos.';
      end if;

      -- Busca item existente no MESMO estoque (region_id = dest) para atualizar sem duplicar:
      existing := null;
      select m.* into existing
        from ssma_epi.materials m
       where m.region_id = dest
         and m.archived_at is null
         and m.no_ca = row_no_ca
         and (row_no_ca or ltrim(trim(m.ca), '0') = ltrim(row_ca, '0'))
         and lower(trim(m.size)) = lower(row_size)
         and lower(trim(m.color)) = lower(row_color)
         and (row_no_ca or lower(trim(m.name)) = lower(row_name) or not exists (
           select 1 from ssma_epi.materials m2
            where m2.region_id = dest and m2.archived_at is null
              and not m2.no_ca and ltrim(trim(m2.ca), '0') = ltrim(row_ca, '0')
              and lower(trim(m2.size)) = lower(row_size) and lower(trim(m2.color)) = lower(row_color)
              and lower(trim(m2.name)) = lower(row_name)
         ))
       order by (lower(trim(m.name)) = lower(row_name)) desc, m.id
       limit 1
       for update;

      if existing.id is not null then
        if row_qty < existing.reserved then
          raise exception 'Quantidade (%) menor que o saldo já reservado em pedidos abertos (%).', row_qty, existing.reserved;
        end if;
        if existing.reserved > 0 and (
          lower(trim(existing.name)) <> lower(row_name)
          or ltrim(trim(existing.ca), '0') <> ltrim(row_ca, '0')
          or lower(trim(existing.size)) <> lower(row_size)
          or lower(trim(existing.color)) <> lower(row_color)
        ) then
          raise exception 'Este material possui % unidade(s) reservada(s); mantenha nome, CA, tamanho e cor iguais ou conclua a reserva antes.', existing.reserved;
        end if;

        row_generics := ssma_epi.generic_cas(
          jsonb_build_object('no_ca', row_no_ca, 'ca', row_ca, 'generic_cas', coalesce(item->'generic_cas', '[]'::jsonb)),
          existing.generic_cas,
          existing.id
        );

        changed_fields := array[]::text[];
        if trim(existing.name) <> row_name then changed_fields := array_append(changed_fields, 'Nome'); end if;
        if existing.qty <> row_qty then changed_fields := array_append(changed_fields, format('Qtd: %s → %s', existing.qty, row_qty)); end if;
        if existing.price <> row_price then changed_fields := array_append(changed_fields, format('Valor: R$ %s → R$ %s', replace(existing.price::text, '.', ','), replace(row_price::text, '.', ','))); end if;
        if existing.minimum <> row_min then changed_fields := array_append(changed_fields, format('Mín: %s → %s', existing.minimum, row_min)); end if;
        if existing.generic_cas is distinct from row_generics then changed_fields := array_append(changed_fields, 'CAs genéricos'); end if;

        if cardinality(changed_fields) = 0 then
          results := results || jsonb_build_array(jsonb_build_object(
            'line', row_line,
            'material', row_name,
            'ca', case when row_no_ca then 'Sem CA' else row_ca end,
            'status', 'unchanged',
            'detail', 'Sem alterações (dados idênticos aos já cadastrados no estoque).'
          ));
        else
          remove_qty := case when existing.price is distinct from row_price then existing.qty else greatest(existing.qty - row_qty, 0) end;
          add_qty := case when existing.price is distinct from row_price then row_qty else greatest(row_qty - existing.qty, 0) end;

          if remove_qty > 0 then
            insert into ssma_epi.movements(owner_id, region_id, material_id, kind, qty, price)
            values (existing.owner_id, dest, existing.id, 'Ajuste de saída', remove_qty, existing.price);
          end if;

          is_glove := existing.insulating_glove or ssma_epi.is_glove(row_name, row_ca);
          update ssma_epi.materials
             set name = row_name,
                 ca = row_ca,
                 no_ca = row_no_ca,
                 generic_cas = row_generics,
                 price = row_price,
                 qty = row_qty,
                 minimum = row_min,
                 size = row_size,
                 color = row_color,
                 insulating_glove = is_glove,
                 glove_start = case when is_glove then coalesce(existing.glove_start, case when row_qty > 0 then today_sp else null end) else null end
           where id = existing.id;

          if add_qty > 0 then
            insert into ssma_epi.movements(owner_id, region_id, material_id, kind, qty, price)
            values (existing.owner_id, dest, existing.id, 'Ajuste de entrada', add_qty, row_price);
          end if;

          results := results || jsonb_build_array(jsonb_build_object(
            'line', row_line,
            'material', row_name,
            'ca', case when row_no_ca then 'Sem CA' else row_ca end,
            'status', 'updated',
            'detail', 'Atualizado (' || array_to_string(changed_fields, '; ') || ').'
          ));
        end if;
      else
        created_mat.id := gen_random_uuid();
        row_generics := ssma_epi.generic_cas(
          jsonb_build_object('no_ca', row_no_ca, 'ca', row_ca, 'generic_cas', coalesce(item->'generic_cas', '[]'::jsonb)),
          '{}'::text[],
          created_mat.id
        );
        is_glove := ssma_epi.is_glove(row_name, row_ca);
        note_suffix := case when is_glove and row_qty > 0 then ' (Luva isolante: data base de ensaio iniciada em hoje; ajuste na validade se necessário)' else '' end;

        insert into ssma_epi.materials(
          id, owner_id, region_id, stock_center, name, ca, no_ca, generic_cas,
          price, qty, minimum, size, color, insulating_glove, glove_start
        ) values (
          created_mat.id, actor.user_id, dest, 'SSMA', row_name, row_ca, row_no_ca, row_generics,
          row_price, row_qty, row_min, row_size, row_color, is_glove,
          case when is_glove and row_qty > 0 then today_sp else null end
        );

        if row_qty > 0 then
          insert into ssma_epi.movements(owner_id, region_id, material_id, kind, qty, price)
          values (actor.user_id, dest, created_mat.id, 'Entrada', row_qty, row_price);
        end if;

        results := results || jsonb_build_array(jsonb_build_object(
          'line', row_line,
          'material', row_name,
          'ca', case when row_no_ca then 'Sem CA' else row_ca end,
          'status', 'created',
          'detail', format('Novo material cadastrado (Qtd: %s · Mín: %s · Valor: R$ %s)%s.', row_qty, row_min, replace(row_price::text, '.', ','), note_suffix)
        ));
      end if;
    exception when others then
      results := results || jsonb_build_array(jsonb_build_object(
        'line', row_line,
        'material', coalesce(nullif(row_name, ''), '(Sem nome)'),
        'ca', case when row_no_ca then 'Sem CA' else coalesce(nullif(row_ca, ''), '—') end,
        'status', 'error',
        'detail', sqlerrm
      ));
    end;
  end loop;

  return jsonb_build_object('results', results);
end $function$;
REVOKE ALL ON FUNCTION ssma_epi.import_stock_rows(uuid, jsonb) FROM public, anon, authenticated;

-- 5. Atualização de ssma_epi.manage_owned (novos status de solicitações + entrega automática ao marcar Concluída)
CREATE OR REPLACE FUNCTION ssma_epi.manage_owned(action text, p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
 actor uuid := auth.uid(); reg ssma_epi.regions; mat ssma_epi.materials; req ssma_epi.requests;
 line ssma_epi.lines; asset ssma_epi.assets;
 amount int; cost numeric(14,2); target text; item_id uuid; region_id_arg uuid := nullif(p->>'region_id','')::uuid;
 new_id uuid;
begin
 if not exists(select 1 from public.ssma_profiles where user_id=actor) then raise exception 'Acesso restrito.'; end if;
 if action in ('material','allocate') then
   select r.* into reg from ssma_epi.regions r where r.id=region_id_arg and (r.distribution_unit is not null or r.individual) and ssma_epi.can_use_stock(r);
   if reg.id is null then raise exception 'Selecione uma unidade de distribuição autorizada.'; end if;
 end if;
 case action
 when 'material' then
   new_id := coalesce(nullif(p->>'id','')::uuid, gen_random_uuid());
   amount := coalesce(nullif(p->>'qty','')::integer,0);
   cost := coalesce(nullif(p->>'price','')::numeric,0);
   insert into ssma_epi.materials(id,owner_id,region_id,stock_center,name,ca,no_ca,price,qty,minimum,expiry,size,color,insulating_glove,glove_start,glove_left_number,glove_right_number,ca_sheet_key,generic_cas)
   values(new_id,actor,reg.id,'SSMA',trim(p->>'name'),trim(coalesce(p->>'ca','')),coalesce((p->>'no_ca')::boolean,false),
   cost,amount,coalesce(nullif(p->>'minimum','')::int,0),nullif(p->>'expiry','')::date,trim(coalesce(p->>'size','')),trim(coalesce(p->>'color','')),
   coalesce((p->>'insulating_glove')::boolean,false) or ssma_epi.is_glove(p->>'name',p->>'ca'),nullif(p->>'glove_start','')::date,
   nullif(trim(p->>'glove_left_number'),''),nullif(trim(p->>'glove_right_number'),''),nullif(p->>'ca_sheet_key',''),
   ssma_epi.generic_cas(p,'{}',new_id))
   returning * into mat;
   if amount>0 then insert into ssma_epi.movements(owner_id,region_id,material_id,kind,qty,price) values(actor,reg.id,mat.id,'Entrada',amount,cost); end if;
 when 'glove_date' then
   update ssma_epi.materials m set glove_start=(p->>'glove_start')::date
   where m.id=(p->>'material_id')::uuid and m.insulating_glove and m.glove_start is not distinct from nullif(p->>'previous','')::date and exists(
   select 1 from public.ssma_profiles t left join ssma_epi.regions r on r.id=m.region_id where t.user_id=actor and t.active and
   (t.is_master or ssma_epi.can_use_stock(r)));
   if not found then raise exception 'Lote indisponível ou já atualizado.'; end if;
 when 'entry','allocate','rule' then
   select * into strict mat from ssma_epi.materials where id=(p->>'material_id')::uuid and archived_at is null and ((region_id is null and (exists(select 1 from public.ssma_profiles where user_id=actor and is_master and active))) or region_id in(select r.id from ssma_epi.regions r where ssma_epi.can_use_stock(r))) for update;
   if action='entry' then
     amount:=(p->>'qty')::int; cost:=coalesce(nullif(p->>'price','')::numeric,mat.price);
     insert into ssma_epi.movements(id,owner_id,region_id,material_id,kind,qty,price) values(coalesce(nullif(p->>'id','')::uuid,gen_random_uuid()),mat.owner_id,mat.region_id,mat.id,'Entrada',amount,cost);
     update ssma_epi.materials set price=round((price*qty+cost*amount)/(qty+amount),2),qty=qty+amount where id=mat.id;
   elsif action='allocate' then
     if mat.region_id is not null or reg.id is null then raise exception 'Selecione um material sem regional e uma regional válida.'; end if;
     update ssma_epi.materials set region_id=reg.id where id=mat.id;
     update ssma_epi.movements set region_id=reg.id where material_id=mat.id and region_id is null;
   else
     insert into ssma_epi.rules values(mat.id,lower(trim(p->>'job')),(p->>'days')::int,(p->>'qty')::int)
     on conflict(material_id,job) do update set days=excluded.days,qty=excluded.qty;
   end if;
 when 'progress' then
   select q.* into strict req from ssma_epi.requests q join ssma_epi.regions r on r.id=q.region_id
   where q.id=(p->>'request_id')::uuid and ssma_epi.can_use_stock(r) for update of q;
   if req.status<>'Solicitado' then raise exception 'Solicitação já encerrada.'; end if;
   target:=p->>'stage';
   if target is null or target not in (
     'Para Aprovação do Gestor','Em Separação','Enviada','Concluída',
     'Pedido recebido','Pedido separado','Aguardando aprovação do projeto','Pronto para retirada na base','Enviado pelos Correios'
   ) then raise exception 'Status inválido.'; end if;
   if req.stage is distinct from p->>'previous_stage' or req.postal is distinct from coalesce(p->>'previous_postal','') then
     raise exception 'O pedido mudou. Atualize a lista antes de continuar.';
   end if;
   if length(trim(coalesce(p->>'postal','')))>64 then raise exception 'Número de rastreamento muito longo.'; end if;
   if target = 'Concluída' then
     update ssma_epi.requests set postal=upper(trim(coalesce(p->>'postal',''))),
       events=events||jsonb_build_array(jsonb_build_object('date',now(),'stage','Concluída'))
     where id=req.id;
     for line in select * from ssma_epi.lines where request_id=req.id order by material_id loop
       select * into strict mat from ssma_epi.materials where id=line.material_id for update;
       if mat.expiry < (now() at time zone 'America/Sao_Paulo')::date or (mat.insulating_glove and (mat.glove_start is null or mat.glove_start > (now() at time zone 'America/Sao_Paulo')::date)) then
         raise exception 'Material vencido. Cancele a reserva e selecione outro material.';
       end if;
       update ssma_epi.materials set reserved=reserved-line.qty, qty=qty-line.qty where id=mat.id;
       update ssma_epi.lines set price=mat.price, delivered_glove=mat.insulating_glove, glove_due=case when mat.insulating_glove then mat.expiry end where request_id=req.id and material_id=mat.id;
       insert into ssma_epi.movements(owner_id,region_id,material_id,request_id,kind,qty,price)
       values(req.owner_id,req.region_id,mat.id,req.id,'Saída',line.qty,mat.price);
     end loop;
     update ssma_epi.requests set status='Entregue', stage='Concluída', closed_at=now(),
       confirmed_by=actor, confirmed_name=(select display_name from public.ssma_profiles where user_id=actor),
       destination='Projeto' where id=req.id;
   elsif req.stage<>target or req.postal<>upper(trim(coalesce(p->>'postal',''))) then
     update ssma_epi.requests set stage=target, postal=upper(trim(coalesce(p->>'postal',''))),
       events=events||jsonb_build_array(jsonb_build_object('date',now(),'stage',target))
     where id=req.id;
   end if;
 when 'deliver','cancel' then
   select q.* into strict req from ssma_epi.requests q join ssma_epi.regions r on r.id=q.region_id
   where q.id=(p->>'request_id')::uuid and ssma_epi.can_use_stock(r) for update of q;
   if req.status<>'Solicitado' then raise exception 'Solicitação já encerrada.'; end if;
   target:=coalesce(nullif(p->>'destination',''), 'Projeto');
   if action='deliver' and target not in ('Projeto','SSMA') then raise exception 'Confirme o destino do custo.'; end if;
   for line in select * from ssma_epi.lines where request_id=req.id order by material_id loop
     select * into strict mat from ssma_epi.materials where id=line.material_id for update;
     if action='deliver' and (mat.expiry < (now() at time zone 'America/Sao_Paulo')::date or (mat.insulating_glove and (mat.glove_start is null or mat.glove_start > (now() at time zone 'America/Sao_Paulo')::date))) then
       raise exception 'Material vencido. Cancele a reserva e selecione outro material.';
     end if;
     update ssma_epi.materials set reserved=reserved-line.qty, qty=qty-case when action='deliver' then line.qty else 0 end where id=mat.id;
     if action='deliver' then
       update ssma_epi.lines set price=mat.price, delivered_glove=mat.insulating_glove, glove_due=case when mat.insulating_glove then mat.expiry end where request_id=req.id and material_id=mat.id;
       insert into ssma_epi.movements(owner_id,region_id,material_id,request_id,kind,qty,price)
       values(req.owner_id,req.region_id,mat.id,req.id,'Saída',line.qty,mat.price);
     end if;
   end loop;
   update ssma_epi.requests set status=case when action='deliver' then 'Entregue' else 'Cancelado' end,
     stage=case when action='deliver' then 'Concluída' else req.stage end,
     closed_at=now(), confirmed_by=actor, confirmed_name=(select display_name from public.ssma_profiles where user_id=actor),
     destination=case when action='deliver' then target end where id=req.id;
 when 'asset' then
   select q.* into strict req from ssma_epi.requests q join ssma_epi.regions r on r.id=q.region_id
   where q.id=(p->>'request_id')::uuid and ssma_epi.can_use_stock(r) and q.status='Entregue' for update of q;
   item_id:=(p->>'material_id')::uuid;
   select * into strict line from ssma_epi.lines where request_id=req.id and material_id=item_id;
   if (select count(*) from ssma_epi.assets where request_id=req.id and material_id=item_id)>=line.qty then raise exception 'Todas as unidades da entrega já têm série.'; end if;
   insert into ssma_epi.assets(owner_id,request_id,material_id,serial,period_days,due) values(req.owner_id,req.id,item_id,trim(p->>'serial'),(p->>'days')::int,(p->>'due')::date);
 when 'test' then
   select a.* into strict asset from ssma_epi.assets a join ssma_epi.requests q on q.id=a.request_id join ssma_epi.regions r on r.id=q.region_id
   where a.id=(p->>'asset_id')::uuid and ssma_epi.can_use_stock(r) for update of a;
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
end $function$;

-- 6. Atualização de ssma_epi.manage (adiciona ações de importação de planilha, exclusão automática do arquivo e logs)
CREATE OR REPLACE FUNCTION ssma_epi.manage(action text, p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  result jsonb; k text; project text:=lower(trim(p->>'project')); dest uuid;
  actor public.ssma_profiles; responsible uuid; unit_label text; file_uuid uuid;
begin
  -- Ações de importação de planilha com isolamento de estoque e exclusão automática do arquivo
  if action in ('import_stage_file', 'import_stock_batch', 'import_finish', 'import_logs', 'all_stock_targets') then
    if not ssma_epi.allowed('epi.estoque') then
      raise exception 'Sem permissão de estoque.' using errcode = '42501';
    end if;
    select * into strict actor from public.ssma_profiles where user_id = auth.uid() and active for share;

    -- Remove automaticamente arquivos temporários órfãos com mais de 15 minutos
    delete from ssma_epi.stock_import_files where created_at < now() - interval '15 minutes';

    if action = 'all_stock_targets' then
      if not actor.is_master then
        return '[]'::jsonb;
      end if;
      return (
        select coalesce(jsonb_agg(to_jsonb(t) order by t.kind, t.label), '[]'::jsonb)
        from (
          select r.id, 'Unidade ' || r.distribution_unit as label, 1 as kind
          from ssma_epi.regions r where r.distribution_unit is not null
          union all
          select p1.user_id as id, 'Estoque individual · ' || p1.display_name as label, 2 as kind
          from public.ssma_profiles p1
          where p1.active and not p1.is_master and p1.stock_unit is null and 'epi.estoque' = any(p1.permissions)
        ) t
      );
    end if;

    if action = 'import_logs' then
      return (
        select coalesce(jsonb_agg(to_jsonb(l) order by l.created_at desc), '[]'::jsonb)
        from (
          select l.id, l.actor_name, l.region_id, l.unit_name, l.file_name,
                 l.total_rows, l.created_count, l.updated_count, l.unchanged_count, l.error_count,
                 l.file_deleted, l.entries, l.created_at
            from ssma_epi.stock_import_logs l
            join ssma_epi.regions r on r.id = l.region_id
           where ssma_epi.can_use_stock(r)
             and (nullif(p->>'region_id', '') is null or l.region_id = (p->>'region_id')::uuid)
           order by l.created_at desc
           limit 25
        ) l
      );
    end if;

    -- Resolve estoque autorizado de destino
    if actor.is_master then
      dest := coalesce(nullif(p->>'region_id', '')::uuid, nullif(p->>'master_unit', '')::uuid);
      if dest is null and nullif(p->>'technician_id', '') is not null then
        responsible := (p->>'technician_id')::uuid;
        select coalesce(t.stock_unit, t.user_id) into dest
          from public.ssma_profiles t
         where t.user_id = responsible and t.active and not t.is_master and 'epi.estoque' = any(t.permissions);
      end if;
      if dest is null then
        select min(t.user_id::text)::uuid into responsible
          from public.ssma_profiles t
         where t.active and not t.is_master and 'epi.estoque' = any(t.permissions)
        having count(*) = 1;
        if responsible is not null then
          select coalesce(t.stock_unit, t.user_id) into dest from public.ssma_profiles t where t.user_id = responsible;
        end if;
      end if;
      if dest is not null and exists(select 1 from public.ssma_profiles t where t.user_id = dest and not t.is_master and t.stock_unit is null) then
        insert into ssma_epi.regions(id, owner_id, technician_id, name, individual)
        select t.user_id, t.user_id, t.user_id, 'Estoque de ' || t.display_name, true
          from public.ssma_profiles t where t.user_id = dest
        on conflict(id) do nothing;
      end if;
    else
      if nullif(p->>'region_id', '') is not null and (p->>'region_id')::uuid <> coalesce(actor.stock_unit, actor.user_id) then
        raise exception 'A importação só pode atualizar o estoque autorizado do seu próprio perfil.' using errcode = '42501';
      end if;
      dest := coalesce(actor.stock_unit, actor.user_id);
      if dest = actor.user_id then
        insert into ssma_epi.regions(id, owner_id, technician_id, name, individual)
        values (actor.user_id, actor.user_id, actor.user_id, 'Estoque de ' || actor.display_name, true)
        on conflict(id) do nothing;
      end if;
    end if;

    if dest is null or not exists(select 1 from ssma_epi.regions r where r.id = dest and ssma_epi.can_use_stock(r)) then
      raise exception 'Selecione uma unidade ou técnico com permissão de estoque habilitada pelo Admin Master.';
    end if;

    if action = 'import_stage_file' then
      insert into ssma_epi.stock_import_files(owner_id, region_id, file_name, byte_size, raw_payload)
      values (
        actor.user_id,
        dest,
        left(coalesce(nullif(trim(p->>'file_name'), ''), 'planilha_estoque.xlsx'), 260),
        greatest(coalesce((p->>'byte_size')::int, 0), 0),
        left(coalesce(p->>'raw_payload', ''), 2000000)
      )
      returning id into file_uuid;
      return jsonb_build_object('file_id', file_uuid, 'region_id', dest);
    end if;

    if action = 'import_stock_batch' then
      return ssma_epi.import_stock_rows(dest, p);
    end if;

    if action = 'import_finish' then
      if nullif(p->>'file_id', '') is not null then
        delete from ssma_epi.stock_import_files
         where id = (p->>'file_id')::uuid and owner_id = actor.user_id;
      end if;
      select coalesce(r.distribution_unit, r.name, 'Estoque') into unit_label
        from ssma_epi.regions r where r.id = dest;

      insert into ssma_epi.stock_import_logs(
        owner_id, actor_name, region_id, unit_name, file_name,
        total_rows, created_count, updated_count, unchanged_count, error_count,
        file_deleted, entries
      ) values (
        actor.user_id,
        actor.display_name,
        dest,
        coalesce(unit_label, 'Estoque'),
        left(coalesce(nullif(trim(p->>'file_name'), ''), 'planilha_estoque.xlsx'), 260),
        coalesce((p->>'total_rows')::int, 0),
        coalesce((p->>'created_count')::int, 0),
        coalesce((p->>'updated_count')::int, 0),
        coalesce((p->>'unchanged_count')::int, 0),
        coalesce((p->>'error_count')::int, 0),
        true,
        coalesce(p->'entries', '[]'::jsonb)
      )
      returning to_jsonb(stock_import_logs.*) into result;

      delete from ssma_epi.stock_import_logs
       where region_id = dest
         and id not in (
           select id from ssma_epi.stock_import_logs where region_id = dest order by created_at desc limit 40
         );
      return result;
    end if;
  end if;

  if action = 'material' and p ? 'master_unit' and nullif(p->>'master_unit', '') is not null then
    if not exists(select 1 from public.ssma_profiles where user_id = auth.uid() and active and is_master) then
      raise exception 'Selecione uma unidade autorizada pelo Master.';
    end if;
    dest := (p->>'master_unit')::uuid;
    if exists(select 1 from public.ssma_profiles t where t.user_id = dest and t.active and not t.is_master and t.stock_unit is null and 'epi.estoque' = any(t.permissions)) then
      insert into ssma_epi.regions(id, owner_id, technician_id, name, individual)
      select t.user_id, t.user_id, t.user_id, 'Estoque de ' || t.display_name, true
        from public.ssma_profiles t where t.user_id = dest
      on conflict(id) do nothing;
    elsif not exists(select 1 from ssma_epi.regions where id = dest and (distribution_unit is not null or individual)) then
      raise exception 'Selecione uma unidade autorizada pelo Master.';
    end if;
    return ssma_epi.manage_owned(action, p || jsonb_build_object('region_id', dest));
  end if;

  if action='toggle_signed' then
    if not (ssma_epi.allowed('epi.solicitacoes') or ssma_epi.allowed('epi.ficha')) then
      raise exception 'Sem permissão para assinar a ficha.' using errcode='42501';
    end if;
    update ssma_epi.requests q
       set sheet_signed = coalesce((p->>'signed')::boolean, not q.sheet_signed),
           sheet_signed_at = case when coalesce((p->>'signed')::boolean, not q.sheet_signed) then now() else null end
     where q.id = (p->>'request_id')::uuid
       and q.status = 'Entregue'
       and exists(select 1 from ssma_epi.regions r where r.id = q.region_id and ssma_epi.can_use_stock(r))
       and ssma_epi.request_in_area(q.employee_id, q.state)
    returning jsonb_build_object('ok', true, 'signed', q.sheet_signed, 'signed_at', q.sheet_signed_at) into result;
    if result is null then raise exception 'Entrega indisponível ou fora da sua área de atendimento.'; end if;
    update ssma_epi.sheets s
       set signed = (result->>'signed')::boolean,
           signed_at = case when (result->>'signed')::boolean then now() else null end
     where s.request_id = (p->>'request_id')::uuid or s.id = (p->>'request_id')::uuid;
    return result;
  end if;

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
    else
      dest := nullif(p->>'region_id','')::uuid;
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
  if action in ('clear_requests','remove_request','edit_request') then return ssma_epi.manage_requests(action,p); end if;
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

-- 7. Atualização de public.ssma_epi_logistics (Correios com CEP, Colaborador/Fornecedor/Outros e Custo no Projeto)
CREATE OR REPLACE FUNCTION public.ssma_epi_logistics(action text, p jsonb default '{}')
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
 actor public.ssma_profiles; dest uuid; item jsonb; m ssma_epi.materials; e public.ssma_records;
 doc ssma_epi.invoices; shipment ssma_epi.shipments; previous_items jsonb:='[]'; new_items jsonb:='[]';
 movement_stamp timestamptz; hist_cleared timestamptz; delta record; new_qty int; new_value numeric;
 invoice_total numeric:=0; amount integer; cost numeric; label text; target_project text; uf text; mid uuid;
 clean_cep text; cep_state text; rec_type text; to_project boolean;
 invoice_cnpj text:=upper(regexp_replace(p->>'cnpj','[^A-Za-z0-9]','','g'));
begin
 select * into strict actor from public.ssma_profiles where user_id=auth.uid() and active;
 if action in ('shipments','ship','edit_ship','delete_ship') then
   if not ssma_epi.allowed('epi.correios') then raise insufficient_privilege; end if;
 elsif action in ('invoices','invoice','edit_invoice','delete_invoice') then
   if not ssma_epi.allowed('epi.financeiro') then raise insufficient_privilege; end if;
 else raise exception 'Operação desconhecida.'; end if;

 if action in ('invoices','shipments') then
   return jsonb_build_object(
     'units', (
       select coalesce(jsonb_agg(jsonb_build_object('id',r.id,'name',coalesce(r.distribution_unit,r.name)) order by r.name),'[]')
       from ssma_epi.regions r where ssma_epi.can_use_stock(r)
     ),
     'projects', case when action='shipments' then (
       select coalesce(jsonb_agg(distinct trim(x.unit) order by trim(x.unit)), '[]'::jsonb)
       from public.ssma_records x
       where x.module='colaboradores' and trim(coalesce(x.unit,'')) <> '' and ssma_epi.record_area(x)
     ) else '[]'::jsonb end,
     'materials', case when action='invoices' then (
       select coalesce(jsonb_agg(jsonb_build_object('id',m1.id,'name',m1.name,'ca',m1.ca,'generic_cas',m1.generic_cas,'size',m1.size,'color',m1.color,'region_id',r.id) order by m1.name),'[]')
       from ssma_epi.materials m1 join ssma_epi.regions r on r.id=m1.region_id
       where m1.archived_at is null and ssma_epi.can_use_stock(r)
     ) else '[]'::jsonb end,
     'employees', case when action='shipments' then (
       select coalesce(jsonb_agg(jsonb_build_object('id',x.id,'name',x.title,'project',x.unit,'state',x.employee_state,'unit',ssma_epi.employee_unit(x)) order by x.title),'[]')
       from public.ssma_records x
       where x.module='colaboradores' and x.status='Ativo' and ssma_epi.record_area(x)
     ) else '[]'::jsonb end,
     'rows', case when action='invoices' then (
       select coalesce(jsonb_agg(to_jsonb(i)-'actor' order by i.issued desc,i.number),'[]')
       from ssma_epi.invoices i join ssma_epi.regions r on r.id=i.unit_id where ssma_epi.can_use_stock(r)
     ) else (
       select coalesce(jsonb_agg(to_jsonb(s)-'actor' order by s.sent desc,s.tracking),'[]')
       from ssma_epi.shipments s join ssma_epi.regions r on r.id=s.unit_id
       where ssma_epi.can_use_stock(r) and (actor.is_master or s.state=any(actor.coverage))
     ) end
   );
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

   clean_cep := regexp_replace(coalesce(p->>'cep', ''), '[^0-9]', '', 'g');
   if clean_cep <> '' and length(clean_cep) <> 8 then
     raise exception 'Informe um CEP válido com 8 dígitos.';
   end if;
   cep_state := ssma_epi.cep_uf(clean_cep);

   rec_type := coalesce(nullif(trim(p->>'recipient_type'), ''), case when nullif(p->>'employee_id', '') is not null then 'Colaborador' else 'Outros' end);
   if rec_type not in ('Colaborador', 'Fornecedor', 'Outros') then
     raise exception 'Tipo de destinatário inválido.';
   end if;

   if rec_type = 'Colaborador' and nullif(p->>'employee_id','') is not null then
     select * into strict e from public.ssma_records x
      where x.id=(p->>'employee_id')::uuid and x.module='colaboradores' and x.status='Ativo'
        and ssma_epi.record_area(x) and (actor.is_master or ssma_epi.employee_unit(x)=dest)
        for share;
     label := e.title;
     uf := coalesce(nullif(trim(p->>'state'), ''), cep_state, e.employee_state);
     if p ? 'charge_project' then
       to_project := coalesce((p->>'charge_project')::boolean, true);
     else
       to_project := coalesce(nullif(trim(p->>'project'), ''), e.unit) not in ('SSMA', 'Setor Facilities');
     end if;
     if to_project then
       target_project := coalesce(nullif(trim(p->>'project'), ''), e.unit);
       if target_project in ('SSMA', 'Setor Facilities') then target_project := e.unit; end if;
     else
       target_project := case when trim(coalesce(p->>'project', '')) in ('SSMA', 'Setor Facilities') then trim(p->>'project') else 'SSMA' end;
     end if;
   else
     e := null;
     label := trim(coalesce(p->>'recipient', ''));
     if label = '' then raise exception 'Informe o nome do destinatário, fornecedor ou empresa.'; end if;
     uf := coalesce(nullif(trim(p->>'state'), ''), cep_state);
     if p ? 'charge_project' then
       to_project := coalesce((p->>'charge_project')::boolean, false);
     else
       to_project := coalesce(nullif(trim(p->>'project'), ''), 'SSMA') not in ('SSMA', 'Setor Facilities');
     end if;
     if to_project then
       target_project := coalesce(nullif(trim(p->>'project'), ''), '');
       if target_project = '' or target_project in ('SSMA', 'Setor Facilities') then
         raise exception 'Informe o projeto que receberá o custo deste envio.';
       end if;
     else
       target_project := case when trim(coalesce(p->>'project', '')) in ('SSMA', 'Setor Facilities') then trim(p->>'project') else 'SSMA' end;
     end if;
   end if;

   if uf is null or not exists(select 1 from jsonb_each(ssma_epi.service_areas()) a where a.value ? uf)
      or not (actor.is_master or uf=any(actor.coverage)) then
     raise exception 'UF fora da área de atendimento.';
   end if;

   if clean_cep <> '' then
     clean_cep := substr(clean_cep, 1, 5) || '-' || substr(clean_cep, 6, 3);
   end if;

   if action='edit_ship' then
     update ssma_epi.shipments
        set sent = (p->>'date')::date,
            tracking = upper(trim(p->>'tracking')),
            employee_id = e.id,
            recipient = label,
            recipient_type = rec_type,
            charge_project = to_project,
            cep = clean_cep,
            project = target_project,
            state = uf,
            mode = p->>'mode',
            cost = (p->>'price')::numeric,
            request_hash = md5(p::text)
      where id = shipment.id;
   else
     insert into ssma_epi.shipments(
       id, unit_id, actor, sent, tracking, employee_id, recipient, project, state, mode, cost, request_hash, cep, recipient_type, charge_project
     ) values (
       (p->>'id')::uuid, dest, auth.uid(), (p->>'date')::date, upper(trim(p->>'tracking')),
       e.id, label, target_project, uf, p->>'mode', (p->>'price')::numeric, md5(p::text),
       clean_cep, rec_type, to_project
     );
   end if;
 else
   if exists(select 1 from ssma_epi.invoices h where h.id=(p->>'id')::uuid and h.actor=auth.uid() and unit_id=dest and h.request_hash=md5(p::text)) then return '{"ok":true}'; end if;
   if action<>'invoice' then
     select * into doc from ssma_epi.invoices h where h.id=(p->>'id')::uuid and h.unit_id=dest for update;
     if not found then raise exception 'Nota fiscal indisponível. Atualize a lista.'; end if;
     if action='edit_invoice' and doc.request_hash=md5(p::text) then return '{"ok":true}'; end if;
     if doc.request_hash is distinct from p->>'previous' then raise exception 'A nota foi alterada. Atualize a lista antes de continuar.'; end if;
     previous_items:=doc.items;
     select min(v.created_at), max(v.history_cleared_at) into movement_stamp, hist_cleared from ssma_epi.movements v where v.invoice_id=doc.id;
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
         insert into ssma_epi.materials(owner_id,region_id,stock_center,name,ca,no_ca,qty,price,size,color,insulating_glove,glove_start,glove_left_number,glove_right_number)
         values(auth.uid(),dest,'SSMA',trim(item->>'name'),trim(coalesce(item->>'ca','')),(item->>'no_ca')::boolean,0,cost,coalesce(item->>'size',''),trim(coalesce(item->>'color','')),
         coalesce((item->>'glove')::boolean,false) or ssma_epi.is_glove(item->>'name',item->>'ca'),nullif(item->>'glove_start','')::date,
         nullif(trim(item->>'glove_left_number'),''),nullif(trim(item->>'glove_right_number'),'')) returning id into mid;
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
     insert into ssma_epi.movements(owner_id,region_id,material_id,kind,qty,price,invoice_id,created_at,history_cleared_at)
       select coalesce(doc.actor,auth.uid()),dest,a.material_id,'Entrada',a.qty,a.price,(p->>'id')::uuid,coalesce(movement_stamp,now()),hist_cleared
       from jsonb_to_recordset(new_items) a(material_id uuid,qty int,price numeric);
     update ssma_epi.invoices set total=invoice_total,items=new_items where id=(p->>'id')::uuid;
   end if;
 end if;
 return '{"ok":true}';
end $function$;

-- 8. Inclui cep, recipient_type, charge_project e stage nos indicadores consolidados
CREATE OR REPLACE FUNCTION ssma_epi.indicators_overview(p jsonb default '{}')
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  actor public.ssma_profiles;
  chosen_tech uuid;
  chosen_profile public.ssma_profiles;
begin
  select * into actor from public.ssma_profiles where user_id = auth.uid() and active;
  if not found or not (actor.is_master or actor.permissions && array['epi.estoque','epi.solicitacoes','epi.financeiro','epi.ficha','epi.correios','epi.historico','epi.compras','epi.ensaios','epi.regionais']) then
    raise exception 'Sem permissão para consultar os indicadores de estoque.' using errcode = '42501';
  end if;

  if actor.is_master and nullif(p->>'technician', '') is not null then
    chosen_tech := (p->>'technician')::uuid;
    select * into chosen_profile from public.ssma_profiles where user_id = chosen_tech;
  end if;

  return (
    with scoped_regions as (
      select r.*, t.display_name as technician_name
      from ssma_epi.regions r
      left join public.ssma_profiles t on t.user_id = r.technician_id
      where ssma_epi.can_use_stock(r)
        and (
          chosen_tech is null
          or (chosen_profile.is_master is true)
          or r.id = coalesce(chosen_profile.stock_unit, chosen_tech)
          or r.technician_id = chosen_tech
        )
    ),
    scoped_materials as (
      select m.id, m.region_id, coalesce(r.distribution_unit, r.name, 'Sem unidade') as unit_name,
        r.state as unit_state, m.name, m.ca, m.no_ca, m.generic_cas, m.size, m.color,
        m.qty, m.reserved, m.minimum, m.price, m.expiry, m.insulating_glove, m.glove_start
      from ssma_epi.materials m
      left join scoped_regions r on r.id = m.region_id
      where m.archived_at is null
        and (
          m.region_id in (select id from scoped_regions)
          or (m.region_id is null and actor.is_master and chosen_tech is null)
        )
    ),
    scoped_requests as (
      select q.id, q.region_id, q.employee_id,
        case when registered.id is null then 'Colaborador removido' else q.employee end as employee,
        coalesce(nullif(registered.unit, ''), q.project) as project,
        coalesce(nullif(registered.employee_state, ''), q.state) as state,
        q.destination, q.status, q.stage, q.list_removed, q.created_at, q.closed_at,
        (q.sheet_signed or exists(select 1 from ssma_epi.sheets s where (s.request_id = q.id or s.id = q.id) and s.signed)) as sheet_signed,
        q.sheet_signed_at,
        exists(select 1 from ssma_epi.sheets s where s.request_id = q.id or s.id = q.id) as has_sheet,
        coalesce((select sum(l.qty * round(l.price * 100))::bigint from ssma_epi.lines l where l.request_id = q.id), 0) as total_cents
      from ssma_epi.requests q
      left join public.ssma_records registered on registered.id = q.employee_id and registered.module = 'colaboradores'
      where q.region_id in (select id from scoped_regions)
        and ssma_epi.request_in_area(q.employee_id, q.state)
        and (chosen_tech is null or chosen_profile.is_master is true or coalesce(registered.employee_state, q.state) = any(coalesce(chosen_profile.coverage, '{}')))
    ),
    glove_deliveries as (
      select e.id as employee_id, e.title as employee,
        coalesce(nullif(e.unit, ''), q.project) as project,
        coalesce(nullif(e.employee_state, ''), q.state) as state,
        q.region_id, l.request_id, l.material_id,
        concat_ws(' · ', l.name, nullif('Tam. ' || nullif(l.size, ''), 'Tam. '), nullif(l.color, '')) as material,
        l.ca, l.qty, l.glove_due, q.closed_at
      from ssma_epi.lines l
      join ssma_epi.requests q on q.id = l.request_id and q.status = 'Entregue'
      join public.ssma_records e on e.id = q.employee_id and e.module = 'colaboradores' and e.status = 'Ativo'
      where q.id in (select id from scoped_requests)
        and (l.delivered_glove or exists(select 1 from ssma_epi.materials m where m.id = l.material_id and m.insulating_glove))
    ),
    glove_tracked as (
      select d.request_id, d.material_id, a.id, a.status = 'Reprovado' as rejected,
        case when renewal.day is null then d.glove_due else least(a.due, renewal.day + 365) end as due
      from glove_deliveries d
      join ssma_epi.assets a using (request_id, material_id)
      left join lateral (
        select (max(t.created_at) at time zone 'America/Sao_Paulo')::date as day
        from ssma_epi.tests t where t.asset_id = a.id and t.status = 'Em retorno'
      ) renewal on true
    ),
    glove_assigned as (
      select request_id, material_id, count(*) as qty from glove_tracked group by request_id, material_id
    ),
    glove_quantities as (
      select d.employee_id, d.employee, d.project, d.state, d.region_id, d.material_id, d.material, d.ca,
        t.due, t.rejected, 1 as quantity, d.closed_at
      from glove_deliveries d join glove_tracked t using (request_id, material_id)
      union all
      select d.employee_id, d.employee, d.project, d.state, d.region_id, d.material_id, d.material, d.ca,
        d.glove_due, false, d.qty - coalesce(c.qty, 0), d.closed_at
      from glove_deliveries d left join glove_assigned c using (request_id, material_id)
    ),
    glove_rows as (
      select employee_id, employee, project, state, region_id, material, ca, due, rejected,
        sum(quantity)::int as qty, max(closed_at) as delivered_at
      from glove_quantities where quantity > 0
      group by employee_id, employee, project, state, region_id, material, ca, due, rejected
    ),
    scoped_movements as (
      select v.id, v.region_id, v.material_id, v.request_id, v.invoice_id, v.kind, v.qty, v.price, v.created_at,
        coalesce(q.state, r.state) as state,
        q.project as project,
        q.destination as destination
      from ssma_epi.movements v
      left join scoped_regions r on r.id = v.region_id
      left join scoped_requests q on q.id = v.request_id
      where (
        v.region_id in (select id from scoped_regions)
        or (v.region_id is null and actor.is_master and chosen_tech is null)
      )
      and (v.request_id is null or v.request_id in (select id from scoped_requests))
    ),
    scoped_sheets as (
      select s.id, s.request_id, s.employee_id, s.number, s.issued_at,
        (s.signed or exists(select 1 from scoped_requests q where (q.id = s.request_id or q.id = s.id) and q.sheet_signed)) as signed,
        s.signed_at,
        coalesce(e.employee_state, s.snapshot->'items'->0->>'state') as state,
        coalesce(e.unit, s.snapshot->>'unit') as project
      from ssma_epi.sheets s
      left join public.ssma_records e on e.id = s.employee_id and e.module = 'colaboradores'
      where (
        actor.is_master
        or s.author = auth.uid()
        or s.request_id in (select id from scoped_requests)
        or s.id in (select id from scoped_requests)
      )
      and (e.id is null or ssma_epi.record_area(e))
      and (chosen_tech is null or chosen_profile.is_master is true or s.author = chosen_tech or coalesce(e.employee_state, '') = any(coalesce(chosen_profile.coverage, '{}')))
    ),
    scoped_shipments as (
      select h.id, h.unit_id, h.sent, h.tracking, h.recipient, h.recipient_type, h.charge_project, h.cep, h.project, h.state, h.mode, h.cost
      from ssma_epi.shipments h
      where h.unit_id in (select id from scoped_regions)
        and (actor.is_master or h.state = any(coalesce(actor.coverage, '{}')))
        and (chosen_tech is null or chosen_profile.is_master is true or h.state = any(coalesce(chosen_profile.coverage, '{}')))
    )
    select jsonb_build_object(
      'technicians', case when actor.is_master then (
        select coalesce(jsonb_agg(jsonb_build_object('id', t.user_id, 'name', t.display_name, 'coverage', t.coverage, 'stock_unit', t.stock_unit) order by t.display_name), '[]'::jsonb)
        from public.ssma_profiles t where t.active and t.removed_at is null
      ) else '[]'::jsonb end,
      'regions', coalesce((select jsonb_agg(to_jsonb(r) order by r.name) from scoped_regions r), '[]'::jsonb),
      'materials', coalesce((select jsonb_agg(to_jsonb(m) order by m.name, m.size) from scoped_materials m), '[]'::jsonb),
      'gloves_delivered', coalesce((select jsonb_agg(to_jsonb(g) order by g.rejected desc, g.due nulls last, g.employee) from glove_rows g), '[]'::jsonb),
      'movements', coalesce((select jsonb_agg(to_jsonb(v) order by v.created_at desc) from scoped_movements v), '[]'::jsonb),
      'requests', coalesce((select jsonb_agg(to_jsonb(q) order by q.created_at desc) from scoped_requests q), '[]'::jsonb),
      'sheets', coalesce((select jsonb_agg(to_jsonb(s) order by s.issued_at desc) from scoped_sheets s), '[]'::jsonb),
      'shipments', coalesce((select jsonb_agg(to_jsonb(h) order by h.sent desc) from scoped_shipments h), '[]'::jsonb)
    )
  );
end $function$;
