import React from 'react'
import {Panel,Table,Field} from './EpiShared'
import {money,regionOf} from './epiData'

export function within(timestamp,{start,end}) {
  if(!timestamp) return false
  const day=timestamp.length===10?timestamp:new Date(timestamp).toLocaleDateString('en-CA',{timeZone:'America/Sao_Paulo'})
  return (!start||day>=start)&&(!end||day<=end)
}
export function DateRange({value,onChange}) {
  return <div className="epi-filters">
    <Field type="date" label="Data inicial" value={value.start} max={value.end||undefined} onChange={e=>onChange({...value,start:e.target.value})}/>
    <Field type="date" label="Data final" value={value.end} min={value.start||undefined} onChange={e=>onChange({...value,end:e.target.value})}/>
    {value.start&&value.end&&value.start>value.end&&<p role="alert">A data inicial precisa vir antes da data final.</p>}
  </div>
}
export function totalsBy(rows,key,cents) {
  const totals=new Map()
  for(const r of rows){const label=key(r)||'Sem informação';totals.set(label,(totals.get(label)||0)+cents(r))}
  return [...totals].sort((a,b)=>b[1]-a[1]).map(([name,v])=>[name,money(v/100)])
}
export function CostBreakdown({requests}) {
  const rows=requests.filter(q=>q.status==='Entregue'&&!q.finance_cleared&&q.destination==='Projeto')
  const cents=q=>q.items.reduce((v,i)=>v+i.qty*Math.round(Number(i.price)*100),0)
  return <Panel title="Valor entregue por projeto e região">
    <div className="epi-split"><Table headers={['Projeto','Valor total']} rows={totalsBy(rows,q=>q.project,cents)}/>
      <Table headers={['Região','Valor total']} rows={totalsBy(rows,q=>regionOf(q.state),cents)}/></div>
  </Panel>
}
export function Consolidated({data,db}) {
  const [costs,setCosts]=React.useState(null),[failed,setFailed]=React.useState(false),[retry,setRetry]=React.useState(0)
  React.useEffect(()=>{
    let active=true
    setFailed(false)
    db.rpc('ssma_epi_stock_costs').then(({data,error})=>{if(active){setFailed(Boolean(error));setCosts(data||[])}})
    return ()=>{active=false}
  },[db,retry])
  const parents=new Map()
  const normalize=ca=>String(ca||'').trim().replace(/^0+(?=\d)/,'')
  for(const m of data.materials){for(const generic of m.generic_cas||[]) parents.set(normalize(generic),normalize(m.ca))}
  const principal=ca=>{let code=normalize(ca);const seen=new Set();while(parents.has(code)&&!seen.has(code)){seen.add(code);code=parents.get(code)}return code}
  const groups=new Map()
  for (const m of data.materials) {
    const ca=m.no_ca?'':principal(m.ca)
    const key=ca?'ca:'+ca:'nome:'+m.name.trim().toLocaleLowerCase('pt-BR')
    const g=groups.get(key)||{names:new Set(),aliases:new Set(),ca,qty:0,cents:0}
    for(const alias of m.generic_cas||[])g.aliases.add(alias)
    g.names.add(m.name);g.qty+=m.qty;g.cents+=m.qty*Math.round(Number(m.price)*100);groups.set(key,g)
  }
  const deliveries=new Map()
  for(const row of costs||[]){
    const ca=principal(row.ca),region=regionOf(row.state),key=JSON.stringify([row.project,region,ca||row.material])
    const group=deliveries.get(key)||{project:row.project,region,ca,names:new Set(),qty:0,cents:0}
    group.names.add(row.material);group.qty+=Number(row.qty);group.cents+=Math.round(Number(row.cost)*100);deliveries.set(key,group)
  }
  return <><Panel title="Estoque consolidado por CA">
    <Table headers={['Material','CA principal','CAs genéricos','Quantidade','Valor médio unitário','Valor total em estoque']}
      rows={[...groups.values()].map(g=>[[...g.names].join(' / '),g.ca||'Sem CA',[...g.aliases].join(', ')||'—',g.qty,g.qty?money(g.cents/g.qty/100):'—',money(g.cents/100)])}/>
  </Panel><Panel title="Distribuição por projeto e região">{failed?<button className="secondary" onClick={()=>setRetry(n=>n+1)}>Falha ao consultar. Tentar novamente</button>:costs===null?<p>Carregando distribuição…</p>:<Table headers={['Projeto','Região','Material','CA','Quantidade entregue','Valor entregue']} rows={[...deliveries.values()].map(r=>[r.project,r.region,[...r.names].join(' / '),r.ca||'Sem CA',r.qty,money(r.cents/100)])}/>}</Panel></>
}
