import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {epiFixture,applyDistributionUnits,applySheetDistribution,applyTechnicianStock} from './epi-db.mjs'

test('estoque individual, vínculo do projeto e compartilhamento autorizado pelo Master',async()=>{
  const {owner,tech,employee,pg,call}=await epiFixture()
  try{
    await pg.query('update public.ssma_profiles set is_master=true where user_id=$1',[owner])
    await applyDistributionUnits(pg)
    await applySheetDistribution(pg)
    await applyTechnicianStock(pg)
    const colleague=randomUUID(),material=randomUUID(),request=randomUUID()
    await pg.query('insert into auth.users(id) values($1)',[colleague])
    await pg.query("insert into public.ssma_profiles(user_id,username,display_name,permissions,coverage) values ($1,'colega','Colega',array['epi.estoque','epi.solicitacoes'],array['DF'])",[colleague])
    await pg.query("update public.ssma_records set details=details||jsonb_build_object('technicianId',$2::text) where id=$1",[employee,tech])
    const units=Object.fromEntries((await pg.query('select distribution_unit,id from ssma_epi.regions')).rows.map(x=>[x.distribution_unit,x.id]))
    const manage=(actor,action,p)=>call(actor,'ssma_epi_manage',{action,p})
    const stock=async actor=>(await call(actor,'ssma_epi_workspace'))?.materials || []
    const portal=(action,p={})=>call(null,'ssma_epi_portal',{action,p:{employee_id:employee,...p}})
    const draft={id:material,technician_id:tech,name:'Botina',ca:'1234',price:145,qty:5}
    await manage(owner,'project_unit',{project:'Projeto Norte',region_id:units.RJ})
    await assert.rejects(manage(owner,'material',{...draft,technician_id:null}),/Selecione um técnico/)
    await assert.rejects(manage(colleague,'material',draft),/seu cadastro/)
    await manage(owner,'material',draft)
    assert.equal((await stock(tech))[0].region_id,tech)
    assert.deepEqual(await stock(colleague),[])
    assert.deepEqual((await portal('context')).materials.map(x=>x.id),[material])
    await portal('submit',{id:request,items:[{id:material,qty:2}]})
    async function assign(person,unit){
      const t=(await call(owner,'ssma_master',{action:'overview',p:{}})).people.find(t=>t.id===person)
      await call(owner,'ssma_master',{action:'edit_technician',p:{technician:t.id,name:t.name,active:t.active,previous_name:t.name,previous_active:t.active,stock_unit:unit,previous_unit:t.stock_unit}})
    }
    await assign(colleague,units.DF)
    assert.deepEqual(await stock(colleague),[])
    await assign(tech,units.DF)
    const shared=(await stock(colleague))[0]
    assert.equal(shared.id,material)
    assert.equal(shared.qty,5)
    assert.equal(shared.reserved,2)
    await manage(colleague,'deliver',{request_id:request})
    assert.equal((await stock(tech))[0].qty,3)
    assert.equal((await portal('context')).materials[0].available,3)
    await pg.query("update public.ssma_profiles set permissions='{}' where user_id=$1",[colleague])
    assert.deepEqual(await stock(colleague),[])
    await assert.rejects(manage(colleague,'entry',{material_id:material,qty:1}),/permissão/)
  }finally{await pg.close()}
})
