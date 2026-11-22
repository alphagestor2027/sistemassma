import React,{useEffect,useRef,useState} from 'react'
import {dateLabel,today} from './data'
import {regionOf} from './epiData'
import {SheetDocument} from './EpiSheetDocument'
import {Table,rpc} from './EpiShared'

export function EmployeeHistory({row,db,close,canViewSheets}){
  const dialog=useRef(null)
  const [history,setHistory]=useState(null),[error,setError]=useState(false),[retry,setRetry]=useState(0)
  useEffect(()=>{const el=dialog.current;el.showModal();return ()=>el.close()},[])
  useEffect(()=>{
    let active=true
    setError(false)
    db.rpc('ssma_employee_history',{p_employee:row.id}).then(({data,error})=>{
      if(active){setError(Boolean(error));setHistory(data)}
    }).catch(()=>{if(active)setError(true)})
    return ()=>{active=false}
  },[db,row.id,retry])
  const d=row.details||{}
  const fields=[['Situação',row.status==='Inativo'?'Desligado':row.status],['Admissão',dateLabel(d.admission)],['Cargo',d.extra],['Matrícula',d.registration],['CPF',d.cpf],['E-mail',d.email],['Empresa',d.company],['CNPJ',d.cnpj],['Projeto',row.unit],['UF',row.employee_state],['Região',regionOf(row.employee_state)||d.region],['Técnico responsável',row.person],['Coordenador',d.coordinator],['Gerência',d.management],['Observações',row.notes]]
  if(d.sector)fields.push(['Setor registrado',d.sector])
  if(row.dismissed_at)fields.push(['Desligamento registrado',dateLabel(row.dismissed_at.slice(0,10))])
  const [sheets,setSheets]=useState([]),[opened,setOpened]=useState(null),[sheetError,setSheetError]=useState('')
  useEffect(()=>{
    let current=true
    if(canViewSheets)rpc(db,'sheet',{action:'context',p:{employee_id:row.id}}).then(v=>{if(current)setSheets(v.sheets)}).catch(e=>{if(current)setSheetError(e.message)})
    return ()=>{current=false}
  },[row.id,db,canViewSheets])
  async function openSheet(id){
    try{setSheetError('');setOpened(await rpc(db,'sheet',{action:'open',p:{employee_id:row.id,id}}))}
    catch(e){setSheetError(e.message)}
  }
  const latest=new Map()
  for(const line of history?.deliveries||[])if(!latest.has(line.material_id))latest.set(line.material_id,line)
  const due=[...latest.values()].filter(l=>l.due&&l.due<=today()&&row.status!=='Inativo')
  return <dialog ref={dialog} className="employee-history" aria-labelledby="employee-history-title" onCancel={close}>
    <header><h2 id="employee-history-title">Prontuário · {row.title}</h2><button className="secondary" onClick={close}>Fechar</button></header>
    <dl>{fields.map(([key,value])=><div key={key}><dt>{key}</dt><dd>{value||'—'}</dd></div>)}</dl>
    <h3>Certificações</h3><Table headers={['Certificação','Situação','Data','Observações']} rows={Object.entries(d.certifications||{}).filter(([,c])=>c&&(c.status||c.date||c.notes)).map(([name,c])=>[name.toUpperCase(),c.status||'—',dateLabel(c.date),c.notes||'—'])}/>
    {error?<p role="alert">Falha ao carregar o histórico. <button onClick={()=>setRetry(n=>n+1)}>Tentar novamente</button></p>:!history?<p role="status">Carregando histórico…</p>:<>
    {due.length>0&&<section className="notice" role="alert"><strong>Solicite uma nova substituição</strong>{due.map(l=><p key={l.material_id}>{l.name} · Prazo de 365 dias atingido. Última retirada em {dateLabel(l.day)}.</p>)}</section>}
    <h3>Materiais retirados</h3><Table headers={['Retirada','Envio','Material','CA','Tamanho','Cor','Quantidade','365 dias em','Rastreio']} rows={history.deliveries.map(l=>[dateLabel(l.day),dateLabel(l.sent),l.name,l.ca||'—',l.size||'—',l.color||'—',l.qty,dateLabel(l.due),l.postal||'—'])}/>
    <h3>Envios ao colaborador</h3><Table headers={['Data de envio','Modalidade','Rastreio']} rows={history.shipments.map(s=>[dateLabel(s.sent),s.mode,s.tracking])}/></>}
    {canViewSheets&&<section><h3>Fichas de EPI concluídas</h3>{sheetError&&<p role="alert">{sheetError}</p>}<Table headers={['Ficha','Emissão','Ações']} rows={sheets.map(s=>[s.number,dateLabel(s.issued_at.slice(0,10)),<button className="secondary" onClick={()=>openSheet(s.id)}>Ver ficha</button>])}/>{opened&&<SheetDocument {...opened} issuedAt={opened.issued_at}/>}</section>}
  </dialog>
}
