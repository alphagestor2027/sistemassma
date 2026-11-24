import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {epiFixture,applyDistributionUnits,applySheetDistribution,applyTechnicianStock} from './epi-db.mjs'

test('ficha em modo rascunho, nova ficha limpa e estorno ao excluir ficha', async () => {
  const {owner,tech,employee,pg,call} = await epiFixture()
  try {
    await pg.query('update public.ssma_profiles set is_master=true where user_id=$1',[owner])
    await applyDistributionUnits(pg)
    await applySheetDistribution(pg)
    await applyTechnicianStock(pg)

    const units = Object.fromEntries((await pg.query('select distribution_unit,id from ssma_epi.regions')).rows.map(r=>[r.distribution_unit,r.id]))
    const manage = (actor,action,p)=>call(actor,'ssma_epi_manage',{action,p})
    const sheet = (actor,action,p={})=>call(actor,'ssma_epi_sheet',{action,p:{employee_id:employee,...p}})
    const logistics = (actor,action,p={})=>call(actor,'ssma_epi_logistics',{action,p})

    await manage(owner,'project_unit',{project:'Projeto Norte',region_id:units.DF})
    await pg.query("update public.ssma_profiles set stock_unit=$2,coverage=array['DF'] where user_id=$1",[tech,units.DF])

    const material = randomUUID()
    await manage(owner,'material',{id:material,region_id:units.DF,name:'Capacete Aba Frontal',ca:'12345',price:50.00,qty:10})

    // 1. Contexto inicial da ficha manual deve começar com lista de itens limpa
    const ctx = await sheet(tech,'context')
    assert.deepEqual(ctx.snapshot.items, [], 'Nova ficha deve começar com lista de itens limpa')

    // 2. Emissão da ficha: deduz estoque
    const sheetId = randomUUID()
    const settings = {identity:{name:'Ana',unit:'Projeto Norte'},logo:'',legal:'Legal',term:'Termo',place:'',reasons:{}}
    const doc = await sheet(tech,'issue',{
      id: sheetId,
      settings,
      version: ctx.version,
      new_items: [{id:material, qty:3, reason:'Inicial'}]
    })

    const stockAfterIssue = (await pg.query('select qty from ssma_epi.materials where id=$1',[material])).rows[0].qty
    assert.equal(stockAfterIssue, 7, 'Estoque deve ser subtraído na emissão da ficha')

    // 3. Ao excluir a ficha, materiais voltam ao estoque e movimentos/valores são estornados
    await sheet(tech,'delete',{id:sheetId, revision:doc.revision})
    const stockAfterDelete = (await pg.query('select qty from ssma_epi.materials where id=$1',[material])).rows[0].qty
    assert.equal(stockAfterDelete, 10, 'Materiais devem retornar ao estoque após exclusão da ficha')

    const movementsAfterDelete = (await pg.query("select count(*)::int n from ssma_epi.movements where request_id=$1",[sheetId])).rows[0].n
    assert.equal(movementsAfterDelete, 0, 'Movimentações devem ser estornadas após exclusão da ficha')

    // 4. Nova ficha para o colaborador volta a iniciar limpa
    const ctxAfter = await sheet(tech,'context')
    assert.deepEqual(ctxAfter.snapshot.items, [], 'Nova ficha deve permanecer limpa sem entregas excluídas')

    // 5. Teste Correios com Centro de Custo Setor Facilities e SSMA
    const shipFacilities = await logistics(tech,'ship',{
      id: randomUUID(),
      unit_id: units.DF,
      date: '2026-11-23',
      tracking: 'BR123456789BR',
      employee_id: employee,
      project: 'Setor Facilities',
      mode: 'SEDEX',
      price: 35.50
    })
    assert.equal(shipFacilities.ok, true)

    const shipments = (await logistics(tech,'shipments',{})).rows
    const createdShip = shipments.find(s=>s.tracking==='BR123456789BR')
    assert.equal(createdShip.project, 'Setor Facilities', 'Envio deve ser atribuído a Setor Facilities')

  } finally {
    await pg.close()
  }
})
