import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { epiFixture, applyDistributionUnits, applySheetDistribution, applyTechnicianStock } from './epi-db.mjs'

test('vínculo automático, área autorizada e validade da luva na entrega', async () => {
  const { owner, tech, call, pg } = await epiFixture()
  try {
    await pg.query('update public.ssma_profiles set is_master=true where user_id=$1', [owner])
    await applyDistributionUnits(pg)
    await applySheetDistribution(pg)
    await applyTechnicianStock(pg)
    await pg.query("update public.ssma_profiles set permissions=array['colaboradores','epi.estoque','epi.solicitacoes','epi.ensaios','epi.ficha'] where user_id=$1", [tech])
    const actorQuery = (actor, sql, args) => pg.transaction(async tx => {
      await tx.exec('set local role authenticated')
      await tx.query("select set_config('request.jwt.claim.sub',$1,true)", [actor])
      return (await tx.query(sql, args)).rows[0]
    })
    const worker = randomUUID(), material = randomUUID(), request = randomUUID()
    const insert = "insert into public.ssma_records(id,owner_id,module,title,unit,status,employee_state,person,details) values ($1,$2,'colaboradores','Ana Técnica','Projeto Teste','Ativo','DF','Escolha Master',$3) returning person,details"
    const saved = await actorQuery(tech, insert, [worker, tech, {technicianId: owner}])
    assert.equal(saved.person, 'Técnico regional')
    assert.equal(saved.details.technicianId, tech)
    const edited = await actorQuery(tech, "update public.ssma_records set person='Outro',details='{}' where id=$1 returning person,details", [worker])
    assert.deepEqual(edited,saved)
    const chosen = await actorQuery(owner, insert, [randomUUID(), owner, {technicianId: tech}])
    assert.equal(chosen.person,'Escolha Master')
    assert.equal(chosen.details.technicianId,tech)

    const { start, due } = (await pg.query("select (current_date-350)::text as start,(current_date+15)::text as due")).rows[0]
    const manage = (action,p) => call(tech,'ssma_epi_manage',{action,p})
    const report = () => call(tech,'ssma_epi_technician_gloves')
    await manage('material',{id:material,name:'Luva isolante',qty:6,no_ca:true,price:10,insulating_glove:true,glove_start:start})
    await call(null,'ssma_epi_portal',{action:'submit',p:{employee_id:worker,id:request,items:[{id:material,qty:3}]}})
    assert.deepEqual(await report(),[])
    await manage('deliver',{request_id:request})
    assert.deepEqual(await report(),[{employee:'Ana Técnica',state:'DF',material:'Luva isolante',qty:3,due,rejected:false}])
    await pg.query("update ssma_epi.materials set glove_start=(now() at time zone 'America/Sao_Paulo')::date where id=$1",[material])
    assert.equal((await report())[0].due,due)
    const asset = await manage('asset',{request_id:request,material_id:material,serial:'L-01',days:365,due})
    assert.ok(asset.ok)
    const assetId = (await pg.query("select id from ssma_epi.assets where serial='L-01'")).rows[0].id
    for (const status of ['Em trânsito','No laboratório','Reprovado'])
      await manage('test',{asset_id:assetId,status,lab:'Laboratório',report:'Ensaio'})
    assert.deepEqual((await report()).map(r=>[r.qty,r.rejected]),[[1,true],[2,false]])
    // Direct issue has no open order. Its priced line must also capture the certificate.
    const direct = randomUUID()
    await pg.transaction(async tx => {
      await tx.query("select set_config('request.jwt.claim.sub',$1,true)",[tech])
      await tx.query('select ssma_epi.sheet_delivery(e,$2,$3::jsonb) from public.ssma_records e where e.id=$1',[worker,direct,JSON.stringify([{id:material,qty:1,reason:'Inicial'}])])
    })
    assert.equal((await report()).reduce((sum,r)=>sum+r.qty,0),4)
    await pg.query("update public.ssma_profiles set coverage=array['RJ'] where user_id=$1",[tech])
    assert.deepEqual(await report(),[])
    await pg.query("update public.ssma_profiles set coverage=array['DF'],stock_unit=(select id from ssma_epi.regions where distribution_unit='RJ') where user_id=$1",[tech])
    // Unit reassignment can move individual stock into the shared unit. A different unit must be excluded.
    await pg.query("update public.ssma_profiles set stock_unit=(select id from ssma_epi.regions where distribution_unit='DF') where user_id=$1",[tech])
    assert.deepEqual(await report(),[])
  } finally { await pg.close() }
})
