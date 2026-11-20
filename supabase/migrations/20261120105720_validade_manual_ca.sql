create table ssma_epi.ca_expiry_changes (
  ca text not null references ssma_epi.ca_catalog(ca),
  sheet_key text not null,
  expiry date not null,
  updated_by uuid not null,
  updated_at timestamptz not null default now(),
  primary key (ca, sheet_key)
);
alter table ssma_epi.ca_expiry_changes enable row level security;
revoke all on ssma_epi.ca_expiry_changes from public, anon, authenticated;

create or replace function ssma_epi.lookup_ca(numero text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not ssma_epi.allowed('epi.estoque') then raise exception 'Sem acesso ao estoque.' using errcode='42501'; end if;
  return (select jsonb_agg(s.ficha || jsonb_build_object('sheet_key',md5(s.ficha::text),'validade_manual',e.expiry) order by s.pos)
    from ssma_epi.ca_catalog c cross join lateral jsonb_array_elements(c.fichas) with ordinality s(ficha,pos)
    left join ssma_epi.ca_expiry_changes e on e.ca=c.ca and e.sheet_key=md5(s.ficha::text)
    where c.ca=ltrim(trim(numero),'0'));
end $$;

create function ssma_epi.change_ca_expiry(p jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare num text:=ltrim(trim(p->>'ca'),'0'); k text:=p->>'sheet_key'; new_date date:=(p->>'ca_expiry')::date; prior date;
begin
  if not ssma_epi.allowed('epi.estoque') then raise exception 'Sem acesso ao estoque.' using errcode='42501'; end if;
  if new_date is null or not isfinite(new_date) then raise exception 'Informe a nova validade do CA.'; end if;
  perform 1 from ssma_epi.ca_catalog c where c.ca=num and exists (
    select 1 from jsonb_array_elements(c.fichas) f where md5(f::text)=k
  ) for update;
  if not found then raise exception 'A ficha do CA mudou. Consulte novamente.'; end if;
  select expiry into prior from ssma_epi.ca_expiry_changes where ca=num and sheet_key=k;
  if prior = new_date then return 'true'::jsonb; end if;
  if prior is distinct from (p->>'previous_ca_expiry')::date then raise exception 'A validade foi alterada. Consulte o CA novamente.'; end if;
  insert into ssma_epi.ca_expiry_changes(ca,sheet_key,expiry,updated_by) values(num,k,new_date,auth.uid())
  on conflict(ca,sheet_key) do update set expiry=excluded.expiry, updated_by=excluded.updated_by, updated_at=now();
  return 'true'::jsonb;
end $$;
revoke all on function ssma_epi.change_ca_expiry(jsonb) from public, anon, authenticated;
grant execute on function ssma_epi.change_ca_expiry(jsonb) to authenticated;

create or replace function public.ssma_epi_manage(action text,p jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare result jsonb;
begin
  if action='ca_expiry' then return ssma_epi.change_ca_expiry(p); end if;
  result:=ssma_epi.manage(action,p);
  if action='material' and p ? 'ca_expiry' then perform ssma_epi.change_ca_expiry(p); end if;
  return result;
end $$;
