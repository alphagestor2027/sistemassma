import React,{useRef,useState} from 'react'
import {Field,Select,Table,rpc} from './EpiShared'
import {stamp} from './epiData'
import {Skeleton} from './Skeleton'

export function NameTracking({db}){
  const [name,setName]=useState(''),[matches,setMatches]=useState(null),[id,setId]=useState('')
  const [rows,setRows]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false)
  const revision=useRef(0)
  async function search(employeeId){
    const n=++revision.current
    setError('');setRows(null);setBusy(true)
    try{
      let selected=employeeId
      if(!selected){
        const choices=await rpc(db,'portal',{action:'track_name',p:{name:name.trim()}})
        if(n!==revision.current)return
        setMatches(choices)
        if(choices.length!==1)return
        selected=choices[0].id
      }
      setId(selected)
      const result=await rpc(db,'portal',{action:'track_employee',p:{name:name.trim(),employee_id:selected}})
      if(n===revision.current)setRows(result)
    }catch(e){if(n===revision.current)setError(e.message)}
    finally{if(n===revision.current)setBusy(false)}
  }
  return <><form className="epi-access" onSubmit={e=>{e.preventDefault();search('')}}>
    <Field label="Nome completo para rastreamento" value={name} required minLength={2} maxLength={254} onChange={e=>{revision.current++;setBusy(false);setName(e.target.value);setId('');setMatches(null);setRows(null);setError('')}}/>
    <button className="secondary" disabled={busy}>Consultar pelo nome</button></form>
    {busy && <Skeleton layout="compact" label="Consultando pedidos…"/>}
    {matches?.length>1 && <Select label="Escolha o colaborador e projeto" value={id} options={matches.map(m=>[m.id,m.name+' · '+m.project])} onChange={e=>{if(e.target.value)search(e.target.value)}}/>}
    {matches?.length===0 && <p role="status">Nenhum colaborador encontrado com esse nome completo.</p>}
    {error && <p className="form-error" role="alert">{error}</p>}
    {rows && <Table headers={['Data do pedido','Projeto','Andamento','Rastreamento dos Correios']} rows={rows.map(q=>[stamp(q.date),q.project,q.status,q.postal||'—'])} empty="Nenhum pedido registrado para este colaborador."/>}
  </>
}
