import React,{useEffect,useRef,useState} from 'react'
import {Sparkles,X} from 'lucide-react'
import {topics,topicAllowed,portalLabels,portalHelp} from './assistantTopics'
import {Skeleton} from './Skeleton'
import {Panel,Table} from './EpiShared'
import {stamp} from './epiData'
import './assistant.css'

async function query(db,body){
  const headers={'Content-Type':'application/json'}
  if(body.action!=='help'){
    const {data}=await db.auth.getSession()
    if(!data.session)throw Error('Entre novamente no sistema.')
    headers.Authorization='Bearer '+data.session.access_token
  }
  const res=await fetch('/api/assistant',{method:'POST',headers,body:JSON.stringify(body)})
  const result=await res.json().catch(()=>({}))
  if(!res.ok||(!result.providers&&!result.answer))throw Error((result.error||'Falha na conexão com o assistente.')+(result.requestId?' · '+result.requestId:''))
  return result
}
function AssistantDialog({db,profile,page,tab,close,openSource}){
  const portal=page==='portal',choices=portal?portalLabels:Object.fromEntries(Object.entries(topics).filter(([k])=>topicAllowed(profile,k)))
  const initial=portal?'solicitar':({dashboard:'priorities',master:'priorities',colaboradores:'employees',epis:({'Solicitações':'orders','Financeiro':'finance','Estoque':'stock','Estoque Consolidado':'stock','Correios':'shipments'})[tab]||'gloves'})[page]||'module'
  const [topic,setTopic]=useState(choices[initial]?initial:Object.keys(choices)[0]),[question,setQuestion]=useState(''),[filter,setFilter]=useState('')
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[result,setResult]=useState(null)
  const dialog=useRef(null)
  useEffect(()=>{const el=dialog.current;el.showModal();return ()=>el.close()},[])
  async function submit(e){
    e.preventDefault();if(busy)return
    setBusy(true);setError('');setResult(null)
    try{setResult(await query(db,{action:portal?'help':'ask',topic,question,filter,page}))}
    catch(err){setError(err.message);if(portal)setResult({answer:portalHelp[topic]})}
    finally{setBusy(false)}
  }
  return <dialog ref={dialog} onCancel={close} className="ai-dialog">
    <div className="dialog-heading"><h2>Assistente SSMA</h2><button className="icon-button" aria-label="Fechar assistente" onClick={close}><X/></button></div>
    <form className="dialog-form" onSubmit={submit}><fieldset disabled={busy}><label>Consulta<select value={topic} onChange={e=>{setTopic(e.target.value);setResult(null);setError('')}}>{Object.entries(choices).map(([k,v])=><option value={k} key={k}>{v}</option>)}</select></label>
      {!portal&&<><label>Filtrar resultados por nome, projeto ou material<input value={filter} maxLength={100} onChange={e=>setFilter(e.target.value)}/></label>
      <label>Pergunta à IA <textarea value={question} maxLength={600} rows="2" placeholder="Ex.: O que devo resolver primeiro?" onChange={e=>setQuestion(e.target.value)}/></label>
      <small>A pergunta é enviada ao provedor de IA. Use o filtro acima para pesquisar nomes e projetos.</small></>}
      <button className="primary" disabled={busy}>{busy?'Consultando…':'Consultar assistente'}</button>
    </fieldset></form>
    {busy&&<Skeleton layout="compact" label="Consultando assistente…"/>}
    {error&&<p className="form-error ai-response" role="alert">{error}</p>}
    {result&&<div className="ai-response" aria-live="polite"><strong>{result.provider?'Resposta · '+result.provider:'Orientação do sistema'}</strong><p className="ai-answer">{result.answer}</p>
      {result.count>0&&<><h3>Registros consultados ({result.facts.length} de {result.count})</h3><ol>{result.facts.map((r,i)=><li key={i}><b>{r.label}</b><p>{Object.entries(r.values).map(([k,v])=>k.replaceAll('_',' ')+' · '+(typeof v==='boolean'?(v?'Sim':'Não'):v??'—')).join(' | ')}</p><button className="text-button" onClick={()=>{close();openSource(r)}}>Abrir origem</button></li>)}</ol></>}</div>}
  </dialog>
}
export function Assistant({db,profile,page,tab,openSource}){
  const [open,setOpen]=useState(false)
  return <><button className="secondary ai-launch" aria-label="Abrir assistente de IA" onClick={()=>setOpen(true)}><Sparkles size={17}/> <span>Assistente IA</span></button>
    {open&&<AssistantDialog db={db} profile={profile} page={page} tab={tab} openSource={openSource} close={()=>setOpen(false)}/>}</>
}
export function Integrations({db}){
  const [data,setData]=useState(null),[busy,setBusy]=useState(''),[notice,setNotice]=useState(''),[error,setError]=useState('')
  async function refresh(){setData(await query(db,{action:'status'}))}
  async function load(){setError('');try{await refresh()}catch(e){setError(e.message)}}
  useEffect(()=>{load()},[db])
  async function probe(p){setBusy(p.id);setNotice('');setError('')
    try{await query(db,{action:'probe',provider:p.id});setNotice(p.name+' está funcionando.')}
    catch(e){setError(e.message)}finally{try{await refresh()}catch(e){setError(e.message)}setBusy('')}
  }
  const ok=data?.latest.filter(e=>e.code==='ok').map(e=>data.providers.find(p=>p.id===e.provider)?.name).filter(Boolean)
  return <Panel title="Integrações de IA" action={<button className="secondary" disabled={!!busy} onClick={load}>Atualizar diagnóstico</button>}>
    {notice&&<p role="status" className="epi-success">{notice}</p>}
    {error&&<p role="alert" className="form-error">{error}</p>}
    {!data&&!error&&<Skeleton label="Carregando integrações…"/>}
    {data&&<><p role="status">{ok.length?'Integração confirmada na última chamada · '+ok.join(', '):'Aguardando confirmação de uma chamada bem-sucedida.'}</p>
    <Table headers={['Ordem','Provedor','Modelo','Última verificação','Situação','Teste']} rows={data.providers.map((p,i)=>{
      const last=data.latest.find(e=>e.provider===p.id)
      return [i+1,p.name,p.model,last?stamp(last.stamp):'—',!p.configured?'Chave ausente':last?.code==='ok'?'Funcionando':last?'Falha · '+last.code:'A testar',
        <button className="secondary" disabled={!!busy} onClick={()=>probe(p)}>{busy===p.id?'Testando…':'Testar '+p.name}</button>]
    })}/>
    <h3>Últimas 100 tentativas</h3>
    <Table headers={['Data','Provedor / modelo','Consulta','Resultado','HTTP','Duração','Detalhes','Identificador']} rows={data.logs.map(e=>[stamp(e.stamp),e.provider+' · '+e.model,e.operation,e.code,e.http,e.duration+' ms',e.detail+(e.retry_at?' Próxima tentativa após '+stamp(e.retry_at):''),e.request_id])}/></>}
  </Panel>
}
