import { PGlite } from '@electric-sql/pglite'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'

export async function epiFixture() {
  const pg = new PGlite(),
    owner = randomUUID(),
    tech = randomUUID(),
    employee = randomUUID()
  await pg.exec(`create schema auth; create role anon; create role authenticated;
 create table auth.users(id uuid primary key,email text unique,raw_app_meta_data jsonb);
 create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
 grant usage on schema auth to authenticated,anon;`)
  for (const file of [
    '../database/schema.sql',
    '../supabase/migrations/20261120010633_epi_operacao.sql',
    '../supabase/migrations/20261120011724_epi_estoque_centro.sql',
    '../supabase/migrations/20261120013706_epi_portal_rastreio.sql',
  ]) {
    await pg.exec(await readFile(new URL(file, import.meta.url), 'utf8'))
  }
  await pg.query('insert into auth.users values ($1),($2)', [owner, tech])
  await pg.query(
    "insert into public.ssma_profiles(user_id,username,display_name) values ($1,'gestao','Gestão'),($2,'tecnico','Técnico regional')",
    [owner, tech],
  )
  await pg.query(
    "insert into public.ssma_records(id,owner_id,module,title,unit,status,details) values ($1,$2,'colaboradores','Ana Silva','Projeto Norte','Ativo',jsonb_build_object('extra','Eletricista'))",
    [employee, owner],
  )
  await pg.exec(
    await readFile(new URL('../supabase/migrations/20261120015613_ssma_master.sql', import.meta.url), 'utf8'),
  )
  await pg.exec(
    await readFile(
      new URL('../supabase/migrations/20261120020836_gestao_tecnicos.sql', import.meta.url),
      'utf8',
    ),
  )
  await pg.exec(
    await readFile(
      new URL('../supabase/migrations/20261120100116_atendimento_tecnico.sql', import.meta.url),
      'utf8',
    ),
  )
  await pg.query("update public.ssma_profiles set service_region='Centro-Oeste',service_state='DF'")
  await pg.exec(
    await readFile(
      new URL('../supabase/migrations/20261120100933_cobertura_multirregional.sql', import.meta.url),
      'utf8',
    ),
  )
  await pg.query("update public.ssma_records set employee_state='DF' where module='colaboradores'")
  const call = (actor, name, body = {}) =>
    pg.transaction(async (tx) => {
      await tx.exec(actor ? 'set local role authenticated' : 'set local role anon')
      await tx.query("select set_config('request.jwt.claim.sub',$1,true)", [actor || ''])
      if (name === 'ssma_epi_dashboard')
        return (await tx.query('select * from public.ssma_epi_dashboard()')).rows
      if (!['ssma_epi_workspace', 'ssma_epi_manage', 'ssma_epi_portal', 'ssma_master'].includes(name))
        throw Error('RPC desconhecida')
      const args = name === 'ssma_epi_workspace' ? [] : [body.action, JSON.stringify(body.p)]
      return (
        await tx.query(
          'select public.' + name + '(' + (args.length ? '$1,$2::jsonb' : '') + ') as result',
          args,
        )
      ).rows[0].result
    })
  return { pg, owner, tech, employee, call }
}
