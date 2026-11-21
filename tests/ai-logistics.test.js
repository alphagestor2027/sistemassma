import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {respond,attempt,providers} from '../server/providers.js'
import {epiFixture,applyDistributionUnits,applySheetDistribution,applyTechnicianStock} from './epi-db.mjs'

test('IA alterna na cota, respeita o intervalo e registra cada tentativa sem conteúdo de entrada',async()=>{
  const trace=[]
  const run=async p=>attempt(p,[{role:'user',content:'privado'}],{env:{[p.key]:'secret'},send:async()=>p.id==='gemini'?
    new Response(JSON.stringify({error:{code:'RESOURCE_EXHAUSTED',message:'privado'}}),{status:429,headers:{'Retry-After':'90'}}):
    Response.json({choices:[{message:{content:'ok'}}]})})
  const response=await respond([],{record:async e=>trace.push(e),run})
  assert.equal(response.provider,'Groq');assert.deepEqual(trace.map(e=>e.code),['quota','ok'])
  assert.ok(Date.parse(trace[0].retry_at)>Date.now());assert.doesNotMatch(JSON.stringify(trace),/privado|secret/)
  const next=await respond([],{record:async()=>{},run,cooldowns:{gemini:trace[0].retry_at,groq:trace[0].retry_at}})
  assert.equal(next.provider,'OpenRouter')
  const failed=await respond([],{record:async()=>{},run:async p=>attempt(p,[],{env:{}})})
  assert.equal(failed,null);assert.equal(providers.length,3)
})
test('nota fiscal em transação, entrada ponderada, isolamento, frete e diagnóstico',async()=>{
  const {pg,tech,owner,call}=await epiFixture()
  try{
    await pg.query('update public.ssma_profiles set is_master=true where user_id=$1',[owner])
    await applyDistributionUnits(pg);await applySheetDistribution(pg);await applyTechnicianStock(pg)
    const df=(await pg.query("select id from ssma_epi.regions where distribution_unit='DF'")).rows[0].id
    const rj=(await pg.query("select id from ssma_epi.regions where distribution_unit='RJ'")).rows[0].id
    await pg.query("update public.ssma_profiles set stock_unit=$1,coverage=array['DF'],permissions=array['epi.financeiro','epi.estoque','epi.correios'] where user_id=$2",[df,tech])
    const rpc=(action,p,actor=tech)=>call(actor,'ssma_epi_logistics',{action,p})
    const item={name:'Avental de teste',ca:'123',no_ca:false,color:'Azul',qty:2,price:10},note={id:randomUUID(),number:'55',date:'2026-11-21',cnpj:'00.111.222/0001-33',items:[item,{...item,name:'Sem certificado',ca:'',no_ca:true,qty:3}]}
    await rpc('invoice',note);await rpc('invoice',note)
    const list=await rpc('invoices',{})
    assert.equal(list.rows.length,1);assert.equal(list.rows[0].total,50)
    const id=list.materials.find(m=>m.ca==='123').id
    await rpc('invoice',{...note,id:randomUUID(),number:'56',items:[{material_id:id,qty:2,price:20}]})
    const saved=(await pg.query('select qty,price from ssma_epi.materials where id=$1',[id])).rows[0]
    assert.equal(saved.qty,4);assert.equal(Number(saved.price),15)
    await assert.rejects(rpc('invoice',{...note,number:'57',id:randomUUID(),items:[item,{...item,qty:-2}]}))
    assert.equal((await rpc('invoices',{})).rows.length,2)
    const inserted=list.rows[0]
    const corrected={...note,items:inserted.items.map(i=>({...i,qty:i.material_id===id?3:i.qty})),previous:inserted.request_hash}
    await rpc('edit_invoice',corrected);await rpc('edit_invoice',corrected)
    assert.equal((await pg.query('select qty from ssma_epi.materials where id=$1',[id])).rows[0].qty,5)
    await assert.rejects(rpc('delete_invoice',{id:note.id,previous:inserted.request_hash}),/alterada/)
    const updated=(await rpc('invoices',{})).rows.find(n=>n.id===note.id)
    await rpc('delete_invoice',{id:note.id,previous:updated.request_hash})
    assert.equal((await pg.query('select qty from ssma_epi.materials where id=$1',[id])).rows[0].qty,2)
    assert.equal((await pg.query('select count(*)::int as n from ssma_epi.movements where invoice_id=$1',[note.id])).rows[0].n,0)
    const ship={id:randomUUID(),tracking:'BR-1234',recipient:'Empresa',project:'Teste DF',state:'DF',date:note.date,mode:'PAC',price:15}
    await rpc('ship',ship);await rpc('ship',ship)
    assert.equal((await rpc('shipments',{})).rows.length,1)
    const first=(await rpc('shipments',{})).rows[0]
    await rpc('edit_ship',{...ship,price:20,previous:first.request_hash})
    const changed=(await rpc('shipments',{})).rows[0]
    assert.equal(changed.cost,20)
    await assert.rejects(rpc('delete_ship',{id:ship.id,previous:first.request_hash}),/alterado/)
    await rpc('delete_ship',{id:ship.id,previous:changed.request_hash})
    assert.equal((await rpc('shipments',{})).rows.length,0)
    await rpc('ship',{...ship,id:randomUUID()})
    await assert.rejects(rpc('ship',{...ship,id:randomUUID(),state:'RJ'}),/atendimento/)
    await pg.query('update public.ssma_profiles set stock_unit=$1 where user_id=$2',[rj,tech])
    assert.equal((await rpc('invoices',{})).rows.length,0)
    assert.equal((await rpc('shipments',{})).rows.length,0)
    await assert.rejects(rpc('invoice',{...note,id:randomUUID(),items:[{material_id:id,qty:1,price:1}]}))
    assert.equal((await rpc('shipments',{},owner)).rows.length,1)
    await assert.rejects(pg.query("select public.ssma_ai_control('event','{}')"),/privilege|permission/i)
  }finally{await pg.close()}
})
