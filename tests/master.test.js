import test from 'node:test'
import assert from 'node:assert/strict'
import { epiFixture } from './epi-db.mjs'
test('somente o Master concede acessos e a revogação alcança as RPCs e os registros', async () => {
  const { pg, owner, tech, call } = await epiFixture()
  try {
    await pg.query('update public.ssma_profiles set is_master=true where user_id=$1', [owner])
    const overview = () => call(owner, 'ssma_master', { action: 'overview', p: {} })
    await assert.rejects(() => call(tech, 'ssma_master', { action: 'overview', p: {} }))
    const data = await overview()
    assert.equal(data.rows.length, 1)
    assert.equal(data.projects[0].project, 'Projeto Norte')
    const previous = data.people.find((p) => p.id === tech).permissions
    const grant = async (previous, permissions) =>
      call(owner, 'ssma_master', { action: 'permissions', p: { technician: tech, previous, permissions } })
    await grant(previous, ['epi.solicitacoes'])
    const space = await call(tech, 'ssma_epi_workspace')
    assert.deepEqual(space.materials, [])
    await assert.rejects(
      () => call(tech, 'ssma_epi_manage', { action: 'material', p: { name: 'Bloqueado' } }),
      /Sem permissão/,
    )
    await grant(['epi.solicitacoes'], [])
    assert.equal(await call(tech, 'ssma_epi_workspace'), null)
    await assert.rejects(() =>
      call(tech, 'ssma_master', {
        action: 'permissions',
        p: { technician: tech, permissions: ['epi.estoque'], previous: [] },
      }),
    )
    await assert.rejects(
      () =>
        pg.transaction(async (tx) => {
          await tx.exec('set local role authenticated')
          await tx.query("select set_config('request.jwt.claim.sub',$1,true)", [tech])
          await tx.query(
            "insert into public.ssma_records(owner_id,module,title) values ($1,'colaboradores','Sem acesso')",
            [tech],
          )
        }),
      /row-level security/,
    )
  } finally {
    await pg.close()
  }
})
