import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile,readdir} from 'node:fs/promises'
import {epiFixture,applyDistributionUnits,applySheetDistribution,applyTechnicianStock} from './epi-db.mjs'

test('prontuário protegido, reativação e expiração após dois anos',async()=>{
 const {pg,owner,employee}=await epiFixture()
 try{
 await pg.query('update public.ssma_profiles set is_master=true where user_id=$1',[owner])
 await applyDistributionUnits(pg);await applySheetDistribution(pg);await applyTechnicianStock(pg)
 const dir=new URL('../supabase/migrations/',import.meta.url)
 const sql=await readFile(new URL((await readdir(dir)).find(s=>s.endsWith('_prontuario.sql')),dir),'utf8')
 await pg.exec(sql.replace(/^select cron.schedule.*$/m,''))
 await pg.query("select set_config('request.jwt.claim.sub',$1,false)",[owner])
 const history=await pg.query('select public.ssma_employee_history($1) h',[employee])
 assert.deepEqual(history.rows[0].h,{deliveries:[],shipments:[]})
 await pg.query("update public.ssma_records set status='Inativo' where id=$1",[employee])
 await pg.exec('select ssma_epi.expire_employees()')
 assert.ok((await pg.query('select dismissed_at from public.ssma_records where id=$1',[employee])).rows[0].dismissed_at)
 await pg.query("update public.ssma_records set status='Ativo' where id=$1",[employee])
 assert.equal((await pg.query('select dismissed_at from public.ssma_records where id=$1',[employee])).rows[0].dismissed_at,null)
 await pg.exec('alter table public.ssma_records disable trigger track_dismissal')
 await pg.query("update public.ssma_records set status='Inativo',dismissed_at=now()-interval '2 years' where id=$1",[employee])
 await pg.exec('select ssma_epi.expire_employees()')
 assert.equal((await pg.query('select id from public.ssma_records where id=$1',[employee])).rows.length,0)
 }finally{await pg.close()}
})
