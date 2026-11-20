create table public.ssma_profiles (
 user_id uuid primary key references auth.users(id) on delete cascade,
 username text not null unique,
 display_name text not null,
 created_at timestamptz not null default now()
);
alter table public.ssma_profiles enable row level security;
revoke all on public.ssma_profiles from anon, authenticated;
grant select on public.ssma_profiles to authenticated;
create policy profile_read_own on public.ssma_profiles for select to authenticated using (user_id = (select auth.uid()));
create table public.ssma_records (
 id uuid primary key default gen_random_uuid(),
 owner_id uuid not null references public.ssma_profiles(user_id),
 module text not null check (module in ('colaboradores','exames','prontuarios','afastamentos','ergonomia','riscos','acidentes','epis','pt','inspecoes','licencas','residuos','emissoes','laia','esocial','treinamentos','terceiros','requisitos')),
 title text not null check (length(trim(title)) between 1 and 200),
 person text not null default '',
 unit text not null default 'Brasília / DF',
 status text not null default 'Pendente' check (status in ('Pendente','Em andamento','Concluído','Ativo','Inativo')),
 event_date date not null default current_date,
 due_date date,
 notes text not null default '',
 details jsonb not null default '{}'::jsonb,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
alter table public.ssma_records enable row level security;
revoke all on public.ssma_records from anon, authenticated;
grant select, insert, update, delete on public.ssma_records to authenticated;
create policy record_read_own on public.ssma_records for select to authenticated using (owner_id = (select auth.uid()));
create policy record_insert_own on public.ssma_records for insert to authenticated with check (owner_id = (select auth.uid()));
create policy record_update_own on public.ssma_records for update to authenticated using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy record_delete_own on public.ssma_records for delete to authenticated using (owner_id = (select auth.uid()));
create index ssma_records_owner_module on public.ssma_records (owner_id, module);
create function public.ssma_touch_updated_at() returns trigger language plpgsql set search_path = '' as $$
begin new.updated_at = now(); return new; end; $$;
revoke all on function public.ssma_touch_updated_at() from public, anon, authenticated;
create trigger ssma_records_updated before update on public.ssma_records for each row execute function public.ssma_touch_updated_at();
