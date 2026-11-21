import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {epiFixture,applyDistributionUnits,applySheetDistribution} from './epi-db.mjs'

test('emissão, custeio e retenção respeitam a unidade e a cobertura do técnico',async()=>{
  const {owner,tech,employee,pg,call}=await epiFixture()
  try{
    await pg.query('update public.ssma_profiles set is_master=true where user_id=$1',[owner])
    await applyDistributionUnits(pg)
    await applySheetDistribution(pg)
    const units=Object.fromEntries((await pg.query('select distribution_unit,id from ssma_epi.regions')).rows.map(r=>[r.distribution_unit,r.id]))
    const manage=(actor,action,p)=>call(actor,'ssma_epi_manage',{action,p})
    const sheet=(actor,action,p={})=>call(actor,'ssma_epi_sheet',{action,p:{employee_id:employee,...p}})
    await manage(owner,'project_unit',{project:'Projeto Norte',region_id:units.DF})
    await pg.query("update public.ssma_profiles set stock_unit=$2,coverage=array['DF'] where user_id=$1",[tech,units.DF])
    const material=randomUUID(),other=randomUUID()
    for(const [id,region_id] of [[material,units.DF],[other,units.RJ]])
      await manage(owner,'material',{id,region_id,name:'Botina',ca:'101',price:19.95,qty:5})
    const ctx=await sheet(tech,'context')
    assert.deepEqual(ctx.materials.map(m=>m.id),[material])
    const settings={identity:{name:'Ana',unit:'Projeto incorreto'},logo:'',legal:'Texto',term:'Termo',place:'',reasons:{}}
    const draft={id:randomUUID(),settings,version:ctx.version,new_items:[{id:material,qty:2,reason:'Inicial'}]}
    await assert.rejects(sheet(tech,'issue',{...draft,new_items:[...draft.new_items,{id:other,qty:1,reason:'Inicial'}]}),/indisponível/)
    await assert.rejects(sheet(tech,'issue',{...draft,new_items:[{id:material,qty:7,reason:'Inicial'}]}),/insuficiente/)
    const doc=await sheet(tech,'issue',draft)
    assert.equal(doc.id,(await sheet(tech,'issue',draft)).id)
    assert.equal(doc.settings.identity.unit,'Projeto Norte')
    assert.equal(Object.values(doc.settings.reasons)[0],'Inicial')
    assert.equal((await pg.query('select qty from ssma_epi.materials where id=$1',[material])).rows[0].qty,3)
    const history=await manage(tech,'history',{start:'2000-01-01',end:'2100-01-01'})
    assert.deepEqual(history.map(v=>v.unit),['DF','DF'])
    assert.equal(Number(history.find(v=>v.kind==='Saída').total),39.90)
    assert.deepEqual(await manage(tech,'history',{start:'2000-01-01',end:'2000-01-01'}),[])
    await pg.query("update ssma_epi.sheets set issued_at=now()-interval '2 years'+interval '71 hours' where id=$1",[doc.id])
    assert.equal((await sheet(tech,'expiring')).length,1)
    await pg.query('update public.ssma_profiles set stock_unit=$2 where user_id=$1',[tech,units.RJ])
    assert.deepEqual(await sheet(tech,'employees'),[])
    assert.deepEqual(await sheet(tech,'expiring'),[])
    await assert.rejects(sheet(tech,'open',{id:doc.id}),/atendimento/)
    await pg.query("update ssma_epi.sheets set issued_at=now()-interval '2 years 1 minute' where id=$1",[doc.id])
    await pg.exec('delete from ssma_epi.sheets where expires_at<=now()')
    assert.equal((await sheet(owner,'context')).sheets.length,0)
    assert.equal((await pg.query("select count(*)::int n from ssma_epi.movements where kind='Saída'")).rows[0].n,1)
  }finally{await pg.close()}
})
