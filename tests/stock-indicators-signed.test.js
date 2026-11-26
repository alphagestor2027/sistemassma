import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { epiFixture, applyDistributionUnits, applySheetDistribution, applyTechnicianStock } from './epi-db.mjs'

test('sincronização de valores, interruptor Assinada e RPC de indicadores de estoque', async () => {
  const { owner, tech, employee, pg, call } = await epiFixture()
  try {
    await pg.query('update public.ssma_profiles set is_master=true where user_id=$1', [owner])
    await applyDistributionUnits(pg)
    await applySheetDistribution(pg)
    await applyTechnicianStock(pg)
    await pg.query(
      "update public.ssma_profiles set permissions=array['epi.estoque','epi.solicitacoes','epi.financeiro','epi.ficha','epi.correios','epi.historico'], coverage=array['DF'] where user_id=$1",
      [tech],
    )

    const units = Object.fromEntries(
      (await pg.query('select distribution_unit,id from ssma_epi.regions where distribution_unit is not null')).rows.map(
        (x) => [x.distribution_unit, x.id],
      ),
    )
    await call(owner, 'ssma_master', {
      action: 'edit_technician',
      p: {
        technician: tech,
        name: 'Técnico regional',
        active: true,
        previous_name: 'Técnico regional',
        previous_active: true,
        stock_unit: units.DF,
        previous_unit: null,
        coverage: ['DF'],
        previous_coverage: ['DF'],
      },
    })
    await pg.query(
      "update public.ssma_records set details=details||jsonb_build_object('technicianId',$2::text) where id=$1",
      [employee, tech],
    )

    const manage = (actor, action, p) => call(actor, 'ssma_epi_manage', { action, p })

    // 1. Cadastra material com preço errado (R$ 1.000,00) e depois corrige para R$ 100,00 -> valida sincronização
    const bootId = randomUUID()
    await manage(tech, 'material', {
      id: bootId,
      name: 'Botina dielétrica',
      ca: '48383',
      price: 1000,
      qty: 5,
      minimum: 10,
    })
    let ws = await call(tech, 'ssma_epi_workspace')
    const rev = ws.materials.find((m) => m.id === bootId).revision
    await manage(tech, 'edit_material', {
      material_id: bootId,
      revision: rev,
      name: 'Botina dielétrica',
      ca: '48383',
      no_ca: false,
      price: 100,
      qty: 5,
      minimum: 10,
      size: '',
      color: '',
    })

    // Cadastra luva isolante próxima do vencimento (vence em 15 dias)
    const gloveId = randomUUID()
    const startSoon = new Date()
    startSoon.setUTCDate(startSoon.getUTCDate() - 350) // 365 - 350 = 15 dias restantes
    const gloveStartStr = startSoon.toISOString().slice(0, 10)
    await manage(tech, 'material', {
      id: gloveId,
      name: 'Luva isolante classe 2',
      ca: '12345',
      price: 250,
      qty: 4,
      minimum: 2,
      insulating_glove: true,
      glove_start: gloveStartStr,
    })

    // Faz pedido e emite ficha para o colaborador
    const reqId = randomUUID()
    await call(null, 'ssma_epi_portal', {
      action: 'submit',
      p: { employee_id: employee, id: reqId, items: [{ id: gloveId, qty: 1 }, { id: bootId, qty: 2 }] },
    })
    const preview = await call(tech, 'ssma_epi_sheet', {
      action: 'context',
      p: { employee_id: employee, request_id: reqId },
    })
    const sheetId = randomUUID()
    await call(tech, 'ssma_epi_sheet', {
      action: 'issue',
      p: {
        id: sheetId,
        employee_id: employee,
        request_id: reqId,
        version: preview.version,
        settings: {
          identity: { name: preview.snapshot.name },
          legal: 'Base legal',
          term: 'Termo de responsabilidade',
          logo: '',
          place: 'Brasília',
          reasons: {},
        },
      },
    })

    // Registra envio pelos Correios
    await call(tech, 'ssma_epi_logistics', {
      action: 'ship',
      p: {
        id: randomUUID(),
        date: new Date().toISOString().slice(0, 10),
        tracking: 'BR999888777DF',
        mode: 'SEDEX',
        employee_id: employee,
        project: 'Projeto Norte',
        price: 45,
      },
    })

    // Verifica sincronização financeira líquida:
    // Botina: 5 * 100 = 500; Luva: 4 * 250 = 1000 -> Entrada líquida = 1500
    // Entrega: 1 * 250 + 2 * 100 = 450 -> Saldo em estoque = 1050 (3 * 100 + 3 * 250)
    ws = await call(tech, 'ssma_epi_workspace')
    const sumMov = (kinds) =>
      ws.movements
        .filter((m) => kinds.includes(m.kind))
        .reduce((s, m) => s + m.qty * Math.round(Number(m.price) * 100), 0)
    const netEntryCents = sumMov(['Entrada', 'Ajuste de entrada']) - sumMov(['Ajuste de saída'])
    const exitCents = sumMov(['Saída'])
    const stockCents = ws.materials.reduce((s, m) => s + m.qty * Math.round(Number(m.price) * 100), 0)
    assert.equal(netEntryCents, 150000)
    assert.equal(exitCents, 45000)
    assert.equal(netEntryCents - exitCents, stockCents)

    // Verifica que antes de marcar Assinada, sheet_signed é false
    const indBefore = await call(tech, 'ssma_epi_indicators', { p: {} })
    assert.equal(indBefore.requests.find((q) => q.id === reqId).sheet_signed, false)
    assert.equal(indBefore.gloves_delivered.length, 1)
    assert.equal(indBefore.gloves_delivered[0].employee, 'Ana Silva')
    assert.equal(indBefore.gloves_delivered[0].project, 'Projeto Norte')
    assert.equal(indBefore.shipments.length, 1)
    assert.equal(Number(indBefore.shipments[0].cost), 45)

    // Aciona interruptor Assinada e verifica sincronização entre solicitação e ficha
    const signedRes = await manage(tech, 'toggle_signed', { request_id: reqId, signed: true })
    assert.equal(signedRes.signed, true)

    const openedSheet = await call(tech, 'ssma_epi_sheet', {
      action: 'open',
      p: { employee_id: employee, id: sheetId },
    })
    assert.equal(openedSheet.signed, true)

    // Master também consulta todos os indicadores consolidados
    const indMaster = await call(owner, 'ssma_epi_indicators', { p: {} })
    assert.equal(indMaster.requests.find((q) => q.id === reqId).sheet_signed, true)
    assert.ok(indMaster.technicians.length >= 1)
  } finally {
    await pg.close()
  }
})
