import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { epiFixture, applyDistributionUnits } from './epi-db.mjs'
import { forecast, expenseGroups } from '../src/epiData.js'

test('ciclo de estoque, autorização, entrega, financeiro e reteste no PostgreSQL', async () => {
  const { pg, owner, tech, employee, call } = await epiFixture()
  try {
    const manage = (actor, action, p) => call(actor, 'ssma_epi_manage', { action, p })
    const space = (actor = owner) => call(actor, 'ssma_epi_workspace')
    const portal = (action, p) => call(null, 'ssma_epi_portal', { action, p })
    await manage(owner, 'region', { state: 'DF', name: 'Central', login: 'tecnico' })
    const region = (await space()).regions[0].id
    await manage(owner, 'assignment', {
      region_id: region,
      employee_id: employee,
      project: 'Obra A',
      job: 'Eletricista',
      center: 'C01',
      contract: '123',
    })
    const who = { employee_id: employee, state: 'DF' }
    assert.equal((await portal('names', {}))[0].name, 'Ana Silva')
    assert.deepEqual(await portal('states', who), ['DF'])
    await assert.rejects(() => portal('context', { ...who, employee_id: randomUUID() }))
    await assert.rejects(() => call(null, 'ssma_epi_workspace'))
    const mat = randomUUID(),
      spare = randomUUID(),
      expired = randomUUID()
    await assert.rejects(() => manage(owner, 'material', { id: mat, name: 'Luva', ca: '' }))
    await manage(owner, 'material', {
      id: mat,
      name: 'Luva',
      region_id: region,
      ca: '99',
      stock_center: 'C01',
      qty: 4,
      price: 10,
      size: 'M',
      minimum: 2,
    })
    await manage(owner, 'material', { id: spare, name: 'Uniforme', no_ca: true })
    await manage(owner, 'allocate', { material_id: spare, region_id: region })
    await manage(owner, 'material', {
      id: expired,
      name: 'Vencido',
      region_id: region,
      no_ca: true,
      qty: 2,
      expiry: '2000-01-01',
    })
    const foreignCenter = randomUUID()
    await manage(owner, 'material', {
      id: foreignCenter,
      name: 'Luva do outro centro',
      region_id: region,
      stock_center: 'C02',
      qty: 20,
      no_ca: true,
    })

    await manage(tech, 'entry', { id: randomUUID(), material_id: mat, qty: 4, price: 20 })
    assert.deepEqual(
      (await portal('context', who)).materials.map((m) => m.id),
      [mat, foreignCenter],
    )
    const request = { ...who, id: randomUUID(), items: [{ id: mat, qty: 2 }] }
    const code = await portal('submit', request)
    assert.match(code, /^EPI-[0-9A-F]{16}$/)
    assert.equal(await portal('submit', request), code)
    let stage = 'Pedido recebido',
      postal = ''
    assert.equal((await portal('track', { code })).stage, stage)
    for (const next of [
      'Pedido separado',
      'Aguardando aprovação do projeto',
      'Pronto para retirada na base',
      'Enviado pelos Correios',
    ]) {
      const update = {
        request_id: request.id,
        stage: next,
        previous_stage: stage,
        previous_postal: postal,
        postal: next === 'Enviado pelos Correios' ? 'AA123456789BR' : '',
      }
      await assert.rejects(() => manage(owner, 'progress', update))
      await manage(tech, 'progress', update)
      stage = next
      postal = update.postal
      const tracked = await portal('track', { code })
      assert.equal(tracked.stage, stage)
      assert.equal(tracked.postal, postal)
    }
    await assert.rejects(() =>
      portal('submit', { ...request, id: randomUUID(), items: [{ id: mat, qty: 7 }] }),
    )
    await assert.rejects(() => manage(owner, 'deliver', { request_id: request.id, destination: 'Projeto' }))

    let data = await space()
    assert.equal(data.requests.length, 1)
    assert.equal(data.materials.find((m) => m.id === mat).reserved, 2)
    assert.equal(expenseGroups(data.requests).length, 0)
    await manage(tech, 'deliver', { request_id: request.id, destination: 'Projeto' })
    await assert.rejects(() => manage(tech, 'deliver', { request_id: request.id, destination: 'SSMA' }))
    const another = { ...request, id: randomUUID(), items: [{ id: mat, qty: 1 }] }
    await portal('submit', another)
    await manage(tech, 'deliver', { request_id: another.id, destination: 'SSMA' })
    const cancelled = { ...request, id: randomUUID() }
    await portal('submit', cancelled)
    await manage(tech, 'cancel', { request_id: cancelled.id })
    data = await space()
    assert.equal(data.materials.find((m) => m.id === mat).qty, 5)
    assert.equal(data.materials.find((m) => m.id === mat).reserved, 0)
    assert.deepEqual(
      expenseGroups(data.requests)
        .map((g) => g.cents)
        .sort((a, b) => a - b),
      [4500],
    )
    await manage(owner, 'asset', {
      request_id: request.id,
      material_id: mat,
      serial: 'L1',
      days: 90,
      due: '2027-01-10',
    })
    const asset = (await space()).assets[0].id
    for (const status of [
      'Em trânsito',
      'No laboratório',
      'Em retorno',
      'Em uso',
      'Em trânsito',
      'No laboratório',
      'Reprovado',
    ])
      await manage(tech, 'test', { asset_id: asset, status, lab: 'Laboratório DF', report: 'L001' })
    data = await space()
    assert.equal(data.assets[0].status, 'Reprovado')
    assert.equal(data.assets[0].history.length, 7)
    await assert.rejects(() => manage(tech, 'test', { asset_id: asset, status: 'Em uso' }))
    assert.equal((await portal('context', who)).history.length, 3)
    assert.equal((await portal('track', { code })).stage, 'Entregue')
    assert.equal((await portal('track', { code })).events.length, 6)
    await assert.rejects(() => portal('track', { code: 'inexistente' }))
    await pg.query("update public.ssma_profiles set coverage=array['SP'] where user_id=$1", [tech])
    data = await space(tech)
    for (const key of ['requests', 'assignments', 'assets']) assert.deepEqual(data[key], [])
    assert.ok(data.movements.every((m) => !m.request_id))
    assert.deepEqual(await call(tech, 'ssma_epi_dashboard'), [])
    await assert.rejects(() => manage(tech, 'test', { asset_id: asset, status: 'Em uso' }), /fora da área/)
  } finally {
    await pg.close()
  }
})

test('previsão considera o cargo, o último recebimento, reservas e estoque mínimo', () => {
  const m = { id: 'm', region_id: 'r', qty: 3, reserved: 1, minimum: 2 },
    rules = [{ material_id: 'm', job: 'eletricista', qty: 2, days: 30 }]
  const members = [
    { employee_id: 'a', region_id: 'r', job: 'Eletricista' },
    { employee_id: 'b', region_id: 'r', job: 'Eletricista', active: false },
  ]
  const requests = [
    { employee_id: 'a', region_id: 'r', items: [{ material_id: 'm', qty: 1 }], status: 'Solicitado' },
  ]
  assert.deepEqual(forecast(m, rules, members, requests, 30, '2026-11-01'), { demand: 3, buy: 3 })
})
test('estoque regional, custo e validade do lote de luvas', async () => {
  const { pg, owner, tech, call } = await epiFixture()
  try {
    const material = randomUUID()
    const save = (actor, p) => call(actor, 'ssma_epi_manage', { action: 'material', p })
    const item = {
      id: material,
      name: 'Luva isolante',
      no_ca: true,
      price: 185.35,
      qty: 2,
      region_state: 'DF',
    }
    await assert.rejects(() => save(tech, item), /data do certificado/)
    await assert.rejects(
      () => save(tech, { ...item, region_state: 'SP', glove_start: '2026-01-01' }),
      /UF fora/,
    )
    await save(tech, { ...item, glove_start: '2026-01-01' })
    const stock = (await call(tech, 'ssma_epi_workspace')).materials.find((m) => m.id === material)
    assert.equal(stock.expiry, '2027-01-01')
    assert.equal(stock.stock_center, 'SSMA')
    const summary = () => call(tech, 'ssma_epi_glove_summary', {})
    const rows = await summary()
    assert.equal(rows.length, 1)
    assert.equal(rows[0].cost, 370.7)
    await pg.query("update public.ssma_profiles set coverage=array['SP'] where user_id=$1", [tech])
    assert.equal((await summary())[0].qty, 0)
    await pg.query('update public.ssma_profiles set is_master=true where user_id=$1', [owner])
    assert.equal((await call(owner, 'ssma_epi_glove_summary', {})).find((r) => r.state === 'DF').qty, 2)
  } finally {
    await pg.close()
  }
})

test('unidades distribuem pelo projeto sem alterar a UF ou as reservas anteriores', async () => {
  const { pg, owner, tech, employee, call } = await epiFixture()
  const manage = (actor, action, p) => call(actor, 'ssma_epi_manage', {action, p})
  const portal = (action, p) => call(null, 'ssma_epi_portal', {action, p})
  try {
    await pg.query('update public.ssma_profiles set is_master=true where user_id=$1',[owner])
    const legacy = randomUUID()
    await manage(owner,'material',{id:legacy,name:'Uniforme',no_ca:true,qty:2})
    await applyDistributionUnits(pg)
    const workspace = await call(owner,'ssma_epi_workspace')
    const units = Object.fromEntries(workspace.regions.map(r => [r.distribution_unit,r.id]))
    assert.deepEqual(Object.keys(units).sort(),['DF','MATRIZ','RJ'])
    assert.equal(workspace.materials[0].region_id,null)
    const routing = region_id => ({project:'Projeto Norte',region_id})
    await assert.rejects(manage(tech,'project_unit',routing(units.MATRIZ)),/Master/)
    await assert.rejects(manage(owner,'material',{id:randomUUID(),name:'Sem unidade',no_ca:true,region_state:'SP'}),/unidade/)
    await manage(owner,'allocate',{material_id:legacy,region_id:units.MATRIZ})
    const other = randomUUID()
    await manage(owner,'material',{id:other,name:'Capacete',no_ca:true,qty:4,region_id:units.RJ})
    await manage(owner,'project_unit',routing(units.MATRIZ))
    const person = {employee_id:employee,state:'DF'}
    assert.deepEqual(await portal('states',person),['DF'])
    assert.deepEqual((await portal('context',person)).materials.map(m=>m.id),[legacy])
    const order = id => ({...person,id:randomUUID(),items:[{id,qty:1}]})
    await assert.rejects(portal('submit',order(other)),/indisponível/)
    await portal('submit',order(legacy))
    await manage(owner,'project_unit',routing(units.RJ))
    assert.deepEqual((await portal('context',person)).materials.map(m=>m.id),[other])
    assert.deepEqual(await portal('states',person),['DF'])
    const after = await call(owner,'ssma_epi_workspace')
    assert.equal(after.requests[0].region_id, units.MATRIZ)
    assert.equal(after.materials.find(m=>m.id===legacy).reserved,1)
    const newcomer = randomUUID()
    await pg.query("insert into public.ssma_records(id,owner_id,module,title,unit,employee_state,status) values($1,$2,'colaboradores','Colaborador novo','PROJETO NORTE','SP','Ativo')",[newcomer,tech])
    assert.equal((await portal('context',{employee_id:newcomer,state:'SP'})).region,'RJ')
  } finally {
    await pg.close()
  }
})

test('edição e exclusão preservam o histórico, as reservas e as permissões de estoque', async () => {
  const { pg, owner, tech, employee, call } = await epiFixture()
  const manage = (actor, action, p) => call(actor,'ssma_epi_manage',{action,p})
  const stock = () => call(owner,'ssma_epi_workspace')
  try {
    await pg.query('update public.ssma_profiles set is_master=true where user_id=$1',[owner])
    await applyDistributionUnits(pg)
    const region = (await stock()).regions.find(r => r.distribution_unit==='RJ').id
    const id = randomUUID()
    const fields = {name:'Óculos',no_ca:true,size:'',color:'',qty:4,price:20,minimum:5,region_id:region}
    await manage(owner,'material',{...fields,id})
    const edit = (revision, extra) => manage(owner,'edit_material',{...fields,material_id:id,revision,...extra})
    await assert.rejects(manage(tech,'delete_material',{material_id:id,revision:0}))
    await edit(0,{name:'Óculos claro',qty:5})
    await assert.rejects(edit(0,{qty:1}),/mudou/)
    await manage(owner,'project_unit',{project:'Projeto Norte',region_id:region})
    const request_id = randomUUID()
    const person = {employee_id:employee,state:'DF'}
    await call(null,'ssma_epi_portal',{action:'submit',p:{...person,id:request_id,items:[{id,qty:2}]}})
    const current = (await stock()).materials.find(m=>m.id===id)
    await assert.rejects(manage(owner,'delete_material',{material_id:id,revision:current.revision}),/reservas/)
    await assert.rejects(edit(current.revision,{name:'Óculos claro',qty:1}),/reservas/)
    await manage(owner,'deliver',{request_id})
    await manage(owner,'delete_material',{material_id:id,revision:(await stock()).materials[0].revision})
    const after = await stock()
    assert.equal(after.materials.length,0)
    assert.equal(after.requests[0].items[0].name,'Óculos claro')
    assert.equal(after.movements.find(v=>v.kind==='Entrada').material_label.name,'Óculos')
    assert.equal(after.movements.find(v=>v.kind==='Ajuste de saída').qty,3)
    assert.equal((await call(null,'ssma_epi_portal',{action:'context',p:person})).materials.length,0)
    await assert.rejects(manage(owner,'entry',{id:randomUUID(),material_id:id,qty:1,price:20}),/excluído/)
  } finally {
    await pg.close()
  }
})

test('ficha emitida conserva o cadastro, limita alterações por área e preserva as entregas', async () => {
  const {pg,owner,tech,employee,call}=await epiFixture()
  const sheet=(actor,action,p={})=>call(actor,'ssma_epi_sheet',{action,p:{employee_id:employee,...p}})
  try {
    await pg.query('update public.ssma_profiles set is_master=true where user_id=$1',[owner])
    await applyDistributionUnits(pg)
    const preview=await sheet(owner,'context')
    const id=randomUUID(), settings={identity:{name:'Ana Silva'},legal:'Texto legal',term:'Termo',logo:'',place:'',reasons:{}}
    const doc=await sheet(owner,'issue',{id,version:preview.version,settings})
    await pg.query("update public.ssma_records set unit='Outro projeto' where id=$1",[employee])
    assert.equal((await sheet(owner,'open',{id})).snapshot.unit,'Projeto Norte')
    await assert.rejects(sheet(null,'open',{id}))
    await assert.rejects(sheet(tech,'edit',{id,revision:1,settings}))
    await sheet(owner,'edit',{id,revision:doc.revision,settings:{...settings,term:'Revisado'}})
    await assert.rejects(sheet(owner,'delete',{id,revision:1}),/alterada/)
    await sheet(owner,'delete',{id,revision:2})
    assert.deepEqual((await sheet(owner,'context')).sheets,[])
  } finally { await pg.close() }
})
