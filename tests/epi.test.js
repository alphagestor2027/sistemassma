import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { epiFixture } from './epi-db.mjs'
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
    const token = await manage(owner, 'key', { employee_id: employee }),
      who = { token, employee_id: employee, state: 'DF' }
    assert.equal((await portal('names', { token }))[0].name, 'Ana Silva')
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
    await assert.rejects(() =>
      portal('submit', { ...who, id: randomUUID(), items: [{ id: foreignCenter, qty: 1 }] }),
    )
    await manage(tech, 'entry', { id: randomUUID(), material_id: mat, qty: 4, price: 20 })
    assert.deepEqual(
      (await portal('context', who)).materials.map((m) => m.id),
      [mat],
    )
    const request = { ...who, id: randomUUID(), items: [{ id: mat, qty: 2 }] }
    await portal('submit', request)
    await portal('submit', request)
    await assert.rejects(() =>
      portal('submit', { ...request, id: randomUUID(), items: [{ id: mat, qty: 7 }] }),
    )
    await assert.rejects(() => manage(owner, 'deliver', { request_id: request.id, destination: 'Projeto' }))
    await assert.rejects(() => manage(tech, 'deliver', { request_id: request.id }))
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
      [1500, 3000],
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
    await manage(owner, 'key', { employee_id: employee })
    await assert.rejects(() => portal('names', { token }))
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
