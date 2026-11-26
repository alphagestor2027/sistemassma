-- 1. Colunas de histórico individualizado e de assinatura da Ficha de EPI
ALTER TABLE ssma_epi.movements ADD COLUMN IF NOT EXISTS history_cleared_at timestamptz;
CREATE INDEX IF NOT EXISTS epi_movements_history_cleared ON ssma_epi.movements(history_cleared_at);

UPDATE ssma_epi.movements SET history_cleared_at = COALESCE(history_cleared_at, cleared_at) WHERE cleared_at IS NOT NULL;
UPDATE ssma_epi.movements SET cleared_at = NULL WHERE cleared_at IS NOT NULL;

ALTER TABLE ssma_epi.sheets
  ADD COLUMN IF NOT EXISTS signed boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS signed_at timestamptz;

ALTER TABLE ssma_epi.requests
  ADD COLUMN IF NOT EXISTS sheet_signed boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS sheet_signed_at timestamptz;

CREATE INDEX IF NOT EXISTS epi_sheets_signed_idx ON ssma_epi.sheets(signed, issued_at);
CREATE INDEX IF NOT EXISTS epi_requests_sheet_signed_idx ON ssma_epi.requests(sheet_signed, closed_at) WHERE status = 'Entregue';

-- 2. Reconciliação de sincronização de valores entre o saldo físico/entregas e o razão financeiro
DO $reconcile$
DECLARE
  rec record;
  expected_entry numeric(14,2);
  recorded_entry numeric(14,2);
  diff numeric(14,2);
  stamp_at timestamptz;
BEGIN
  FOR rec IN SELECT * FROM ssma_epi.materials LOOP
    SELECT COALESCE(SUM(ROUND(v.qty * v.price, 2)), 0)
      INTO expected_entry
      FROM ssma_epi.movements v
     WHERE v.material_id = rec.id AND v.kind = 'Saída';

    expected_entry := ROUND(rec.qty * rec.price, 2) + expected_entry;

    SELECT COALESCE(SUM(
      CASE
        WHEN v.kind IN ('Entrada', 'Ajuste de entrada') THEN ROUND(v.qty * v.price, 2)
        WHEN v.kind = 'Ajuste de saída' THEN -ROUND(v.qty * v.price, 2)
        ELSE 0
      END
    ), 0)
      INTO recorded_entry
      FROM ssma_epi.movements v
     WHERE v.material_id = rec.id;

    diff := ROUND(expected_entry - recorded_entry, 2);
    IF ABS(diff) > 0.50 THEN
      SELECT COALESCE(MAX(created_at), now()) INTO stamp_at FROM ssma_epi.movements WHERE material_id = rec.id;
      IF diff < 0 THEN
        INSERT INTO ssma_epi.movements(owner_id, region_id, material_id, kind, qty, price, created_at, history_cleared_at)
        VALUES (rec.owner_id, rec.region_id, rec.id, 'Ajuste de saída', 1, ABS(diff), stamp_at, now());
      ELSE
        INSERT INTO ssma_epi.movements(owner_id, region_id, material_id, kind, qty, price, created_at, history_cleared_at)
        VALUES (rec.owner_id, rec.region_id, rec.id, 'Ajuste de entrada', 1, diff, stamp_at, now());
      END IF;
    END IF;
  END LOOP;
END $reconcile$;

-- 3. Mantém valores sincronizados ao editar preço, quantidade ou unidade de um material
CREATE OR REPLACE FUNCTION ssma_epi.maintain_material(action text, p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
 m ssma_epi.materials; dest uuid; new_qty int; new_price numeric(14,2); moved boolean;
 add_qty int; remove_qty int; is_glove boolean;
begin
 if action not in ('edit_material','delete_material') or not ssma_epi.allowed('epi.estoque') then
   raise exception 'Sem permissão para alterar o estoque.';
 end if;
 select s.* into m from ssma_epi.materials s
 where s.id=(p->>'material_id')::uuid and s.archived_at is null and
 ((s.region_id is null and exists(select 1 from public.ssma_profiles t where t.user_id=auth.uid() and t.active and t.is_master))
  or exists(select 1 from ssma_epi.regions r where r.id=s.region_id and ssma_epi.can_use_stock(r)))
 for update;
 if not found then raise exception 'Material indisponível para este usuário.'; end if;
 if m.revision is distinct from (p->>'revision')::bigint then
   raise exception 'O material mudou. Atualize o estoque e abra a ação novamente.';
 end if;
 if action='delete_material' then
   if m.reserved>0 then raise exception 'Conclua ou cancele as reservas antes de excluir este material.'; end if;
   if m.qty>0 then
     insert into ssma_epi.movements(owner_id,region_id,material_id,kind,qty,price)
     values(m.owner_id,m.region_id,m.id,'Ajuste de saída',m.qty,m.price);
   end if;
   update ssma_epi.materials set qty=0, archived_at=now() where id=m.id;
 else
   dest:=(p->>'region_id')::uuid;
   if not exists(select 1 from ssma_epi.regions r where r.id=dest and (r.distribution_unit is not null or r.individual) and ssma_epi.can_use_stock(r)) then
     raise exception 'Selecione uma unidade de distribuição autorizada.';
   end if;
   moved := m.region_id is distinct from dest;
   new_qty:=(p->>'qty')::int;
   new_price:=(p->>'price')::numeric;
   if new_qty<m.reserved or (m.reserved>0 and (moved or
      (m.name,m.ca,m.size,m.color) is distinct from (trim(p->>'name'),trim(coalesce(p->>'ca','')),trim(p->>'size'),trim(p->>'color')))) then
      raise exception 'A alteração é incompatível com as reservas deste material.';
   end if;
   remove_qty:=case when moved or m.price is distinct from new_price then m.qty else greatest(m.qty-new_qty,0) end;
   add_qty:=case when moved or m.price is distinct from new_price then new_qty else greatest(new_qty-m.qty,0) end;
   if remove_qty>0 then
     insert into ssma_epi.movements(owner_id,region_id,material_id,kind,qty,price)
     values(m.owner_id,m.region_id,m.id,'Ajuste de saída',remove_qty,m.price);
   end if;
   is_glove:=coalesce((p->>'insulating_glove')::boolean,false) or ssma_epi.is_glove(p->>'name',p->>'ca');
   update ssma_epi.materials set generic_cas=ssma_epi.generic_cas(p,m.generic_cas,m.id),
     name=trim(p->>'name'), ca=trim(coalesce(p->>'ca','')), no_ca=(p->>'no_ca')::boolean,
     ca_sheet_key=case when (p->>'no_ca')::boolean then null when p ? 'ca_sheet_key' then nullif(p->>'ca_sheet_key','') when trim(p->>'ca')=m.ca then m.ca_sheet_key end,
     minimum=(p->>'minimum')::int, qty=new_qty, price=new_price, size=trim(p->>'size'), color=trim(p->>'color'),
     region_id=dest, expiry=nullif(p->>'expiry','')::date, insulating_glove=is_glove,
     glove_left_number=case when is_glove then case when p ? 'glove_left_number' then nullif(trim(p->>'glove_left_number'),'') else m.glove_left_number end end,
     glove_right_number=case when is_glove then case when p ? 'glove_right_number' then nullif(trim(p->>'glove_right_number'),'') else m.glove_right_number end end,
     glove_start=case when is_glove then nullif(p->>'glove_start','')::date end
   where id=m.id;
   if add_qty>0 then
     insert into ssma_epi.movements(owner_id,region_id,material_id,kind,qty,price)
     values(m.owner_id,dest,m.id,'Ajuste de entrada',add_qty,new_price);
   end if;
   if p ? 'ca_expiry' then perform ssma_epi.change_ca_expiry(p); end if;
 end if;
 return jsonb_build_object('ok',true);
end $function$;

-- 4. Workspace com status de assinatura das fichas e movimentos financeiros preservados
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
$function$;

-- 5. Gerenciamento com ação toggle_signed e limpeza isolada de histórico
CREATE OR REPLACE FUNCTION ssma_epi.manage(action text, p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare result jsonb; k text; project text:=lower(trim(p->>'project')); dest uuid; actor public.ssma_profiles; responsible uuid;
begin
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

-- 6. Ficha de EPI sincronizada com assinatura
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
 next_signed boolean;
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
   return (select coalesce(jsonb_agg(jsonb_build_object('id',e1.id,'name',e1.title) order by e1.title,e1.id),'[]')
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

-- 7. RPC consolidada de Indicadores de Estoque, Luvas Isolantes, Fichas Assinadas e Correios (para todos os painéis e Admin Master)
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
        r.state as unit_state, m.name, m.ca, m.no_ca, m.size, m.color,
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
        q.destination, q.status, q.created_at, q.closed_at,
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
      select h.id, h.unit_id, h.sent, h.tracking, h.recipient, h.project, h.state, h.mode, h.cost
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

CREATE OR REPLACE FUNCTION public.ssma_epi_indicators(p jsonb default '{}')
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY INVOKER
 SET search_path TO ''
AS $function$
  select ssma_epi.indicators_overview(p)
$function$;

REVOKE ALL ON FUNCTION ssma_epi.indicators_overview(jsonb), public.ssma_epi_indicators(jsonb) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION ssma_epi.indicators_overview(jsonb), public.ssma_epi_indicators(jsonb) TO authenticated;
