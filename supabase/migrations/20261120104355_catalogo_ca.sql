create table ssma_epi.ca_catalog (
  ca text primary key check (ca ~ '^[0-9]+$'),
  fichas jsonb not null check (jsonb_typeof(fichas) = 'array' and jsonb_array_length(fichas) > 0)
);
alter table ssma_epi.ca_catalog enable row level security;
revoke all on ssma_epi.ca_catalog from public, anon, authenticated;

create function ssma_epi.lookup_ca(numero text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not ssma_epi.allowed('epi.estoque') then
    raise exception 'Sem acesso ao estoque.' using errcode = '42501';
  end if;
  return (select fichas from ssma_epi.ca_catalog where ca = coalesce(nullif(ltrim(trim(numero),'0'),''),'0'));
end $$;

create function public.ssma_epi_lookup_ca(numero text) returns jsonb
language sql stable security invoker set search_path = '' as $$select ssma_epi.lookup_ca(numero)$$;
revoke all on function ssma_epi.lookup_ca(text), public.ssma_epi_lookup_ca(text) from public, anon, authenticated;
grant execute on function ssma_epi.lookup_ca(text), public.ssma_epi_lookup_ca(text) to authenticated;
