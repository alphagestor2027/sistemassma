import {available,regionOf,variant} from '../src/epiData.js'
import {today} from '../src/data.js'
import {topicAllowed} from '../src/assistantTopics.js'

const days=(day,n)=>new Date(Date.parse(day)+86400000*n).toISOString().slice(0,10)
const localDay=date=>new Date(date).toLocaleDateString('en-CA',{timeZone:'America/Sao_Paulo'})
const priceCents=v=>Math.round(Number(v)*100)
async function result(query){const {data,error}=await query;if(error)throw Error('Falha ao consultar os registros autorizados.');return data}
export async function evidence(db,profile,topic,page,filter='',day=today()){
  const facts=[],totals={}
  const include=t=>(topic===t||topic==='priorities')&&topicAllowed(profile,t)
  const matches=s=>!filter||s.toLocaleLowerCase('pt-BR').includes(filter.toLocaleLowerCase('pt-BR'))
  const add=(section,label,values,source,tab,id)=>{
    if(!matches(label))return
    totals[section]=(totals[section]||0)+1
    facts.push({section,label,values,source,tab,id})
  }
  if(profile.is_master && ['master','technicians'].includes(page) && ['module','priorities'].includes(topic)){
    const summary=await result(db.rpc('ssma_master',{action:'overview',p:{}}))
    for(const p of summary.people.filter(p=>!p.master)){
      const gaps=[]
      if(!p.active)gaps.push('Acesso bloqueado')
      if(!p.coverage?.length)gaps.push('Área de atendimento ausente')
      if(!p.stock_unit)gaps.push('Sem unidade compartilhada')
      if(!p.permissions?.length)gaps.push('Sem módulos liberados')
      if(gaps.length)add('Gestão de técnicos',p.name,{conferir:gaps.join(', ')},'technicians')
    }
  }
  const wantsWorkspace=['stock','gloves','finance'].some(include)
  const workspace=wantsWorkspace?await result(db.rpc('ssma_epi_workspace')):null
  const materials=workspace?.materials||[],orders=workspace?.requests||[]
  if(include('gloves')){
    const gloves=await result(db.rpc('ssma_ai_gloves'))
    const matchKey=(region,ca,size,id)=>JSON.stringify([region,ca?'CA '+ca.trim().replace(/^0+/,''):id,(size||'').trim().toLowerCase()])
    const stock=new Map()
    for(const m of materials.filter(m=>m.insulating_glove)){
      const key=matchKey(m.region_id,m.ca,m.size,m.id)
      stock.set(key,(stock.get(key)||0)+available(m,day))
    }
    for(const g of gloves){
      if(!g.rejected&&g.due&&g.due>days(day,30))continue
      const key=matchKey(g.region_id,g.ca,g.size,g.material_id)
      const hasStock=profile.is_master||profile.permissions.includes('epi.estoque')
      const onHand=stock.get(key)||0,allocated=Math.min(onHand,g.qty)
      if(hasStock)stock.set(key,onHand-allocated)
      add('Trocas',g.employee+' · '+g.material+' · '+(g.size||'sem tamanho')+' · '+g.state,
        {quantidade:g.qty,validade:g.due||'Conferir certificado',reprovada:g.rejected,...(hasStock?{disponível_compatível:allocated,faltam:g.qty-allocated}:{estoque:'Sem permissão para consulta'})},'epis',hasStock?'Estoque':(profile.permissions.includes('epi.ficha')?'Ficha digital':'Solicitações'),hasStock?g.material_id:null)
    }
  }
  if(include('stock'))for(const m of materials){
    const saldo=available(m,day)
    if(saldo<m.minimum)add('Reposição',variant(m)+' · CA '+(m.ca||'ausente'),{disponível:saldo,mínimo:m.minimum,comprar:m.minimum-saldo},'epis','Estoque',m.id)
  }
  if(include('orders')){
    const readiness=await result(db.rpc('ssma_ai_order_readiness'))
    for(const q of readiness)add('Pedidos',q.employee+' · '+q.project+' · '+q.items,{itens:q.lines,liberação:q.ready?'Reserva disponível':'Conferir pendências'},'epis','Solicitações',q.id)
  }
  if(include('employees')||topic==='module'||topic==='priorities'){
    // RLS restricts each page, including records shared across owners. Only operational metadata is selected.
    for(let from=0;;from+=500){
      let query=db.from('ssma_records').select('id,module,status,due_date').order('id').range(from,from+499)
      if(topic==='module'&&!['dashboard','master','technicians','bi','epis','integrations'].includes(page))query=query.eq('module',page)
      if(topic==='employees')break
      const rows=await result(query)
      for(const r of rows){
        if(['Ativo','Concluído','Inativo'].includes(r.status))continue
        if(topic==='priorities'&&(!r.due_date||r.due_date>days(day,7)))continue
        add('Registros',r.module+' · '+r.status,{situação:r.status,prazo:r.due_date||'Sem prazo'},r.module,null,r.id)
      }
      if(rows.length<500)break
    }
    if(include('employees'))for(let from=0;;from+=500){
      const rows=await result(db.from('ssma_records').select('id,title,unit,employee_state,person,details').eq('module','colaboradores').eq('status','Ativo').order('id').range(from,from+499))
      for(const e of rows){
        const d=e.details||{},gaps=[]
        if(!e.unit)gaps.push('Projeto')
        if(!e.employee_state)gaps.push('UF')
        if(!e.person&&!d.technicianId)gaps.push('Técnico responsável')
        if(!d.registration&&!d.cpf)gaps.push('Matrícula ou CPF')
        for(const [nr,c] of Object.entries(d.certifications||{}))if(c?.status==='Ativo'&&!c.date)gaps.push(nr.toUpperCase()+' ativa sem data')
        if(gaps.length)add('Cadastro',e.title+' · '+e.unit,{conferir:gaps.join(', ')},'colaboradores',null,e.id)
      }
      if(rows.length<500)break
    }
  }
  if(include('finance')){
    const start=day.slice(0,7)+'-01',priorEnd=days(start,-1),prior=priorEnd.slice(0,7)+'-01'
    const previousThrough=prior.slice(0,8)+(day.slice(-2)>priorEnd.slice(-2)?priorEnd.slice(-2):day.slice(-2))
    const projects=new Map()
    for(const q of orders.filter(q=>q.status==='Entregue'&&q.destination==='Projeto'&&!q.finance_cleared&&q.closed_at)){
      const d=localDay(q.closed_at),current=d>=start&&d<=day
      if(!current&&(d<prior||d>previousThrough))continue
      for(const i of q.items){const key=q.project+' · '+regionOf(q.state)+' · '+variant(i),v=projects.get(key)||[0,0,0,0],index=current?0:2
        v[index]+=priceCents(i.price)*i.qty;v[index+1]+=i.qty;projects.set(key,v)}
    }
    for(const [key,[c,n,p,m]] of projects)add('Custos',key,{atual_R$:c/100,anterior_R$:p/100,variação_R$:(c-p)/100,quantidade_atual:n,quantidade_anterior:m,preço_médio_atual_R$:n?Math.round(c/n)/100:null,preço_médio_anterior_R$:m?Math.round(p/m)/100:null},'epis','Financeiro')
    totals.período_atual=start+' a '+day;totals.período_anterior=prior+' a '+previousThrough
  }
  if(topic==='shipments'&&include('shipments')){
    const data=await result(db.rpc('ssma_epi_logistics',{action:'shipments',p:{}})),groups=new Map()
    for(const s of data.rows){const k=s.project+' · '+regionOf(s.state);groups.set(k,(groups.get(k)||0)+priceCents(s.cost))}
    for(const [k,c] of groups)add('Envios',k,{gasto_R$:c/100},'epis','Correios')
  }
  return {day,totals,count:facts.length,facts:facts.slice(0,60)}
}
