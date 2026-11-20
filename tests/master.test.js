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
test('cobertura compartilhada filtra colaboradores e registros pelo estado e pela permissão do módulo', async () => {
  const { pg, owner, tech, employee } = await epiFixture()
  try {
    const asTech = (sql, args = []) =>
      pg.transaction(async (tx) => {
        await tx.exec('set local role authenticated')
        await tx.query("select set_config('request.jwt.claim.sub',$1,true)", [tech])
        return (await tx.query(sql, args)).rows
      })
    const visible = async () =>
      (await asTech('select title from public.ssma_records order by title')).map((row) => row.title)
    assert.deepEqual(
      (await pg.query('select coverage from public.ssma_profiles where user_id=$1', [tech])).rows[0].coverage,
      ['DF'],
    )
    assert.deepEqual(
      (await pg.query("select ssma_epi.legacy_coverage('Sul',null) as ufs")).rows[0].ufs.sort(),
      ['PR', 'RS', 'SC'],
    )
    const addEmployee = async (title, uf, actor) =>
      (
        await pg.query(
          "insert into public.ssma_records(owner_id,module,title,employee_state,unit) values($1,'colaboradores',$2,$3,'Obra') returning id",
          [actor, title, uf],
        )
      ).rows[0].id
    const paul = await addEmployee('Paulo', 'SP', owner),
      bia = await addEmployee('Bia', 'BA', tech)
    await addEmployee('Sem UF', null, owner)
    for (const [id, title] of [
      [employee, 'Exame DF'],
      [paul, 'Exame SP'],
      [bia, 'Exame BA'],
    ]) {
      await pg.query(
        "insert into public.ssma_records(owner_id,module,title,employee_id) values($1,'exames',$2,$3)",
        [owner, title, id],
      )
    }
    await pg.query(
      "insert into public.ssma_records(owner_id,module,title,person) values($1,'exames','Legado BA','Bia')",
      [tech],
    )
    await pg.query("update public.ssma_profiles set coverage=array['DF','SP'] where user_id=$1", [tech])
    assert.deepEqual(await visible(), ['Ana Silva', 'Exame DF', 'Exame SP', 'Paulo'])
    assert.deepEqual(
      await asTech("update public.ssma_records set notes='x' where id=$1 returning id", [paul]),
      [],
    )
    await assert.rejects(
      () =>
        asTech(
          "insert into public.ssma_records(owner_id,module,title,employee_id) values($1,'exames','Outro',$2)",
          [tech, bia],
        ),
      /row-level security/,
    )
    await pg.query("update public.ssma_profiles set permissions=array['exames'] where user_id=$1", [tech])
    assert.deepEqual(await visible(), ['Exame DF', 'Exame SP'])
    await pg.query("update public.ssma_profiles set coverage='{}' where user_id=$1", [tech])
    assert.deepEqual(await visible(), [])
  } finally {
    await pg.close()
  }
})
