import React, {useEffect, useState} from 'react'
import {Panel, Field, Table, rpc} from './EpiShared'
import {today} from './data'
import {stamp, money, variant} from './epiData'
import {recentPeriod} from './reportFilters'
import {permitted} from './access'

export function StockHistory({db,profile}) {
  const [period,setPeriod]=useState('30'), [custom,setCustom]=useState(()=>recentPeriod(30,today()))
  const [rows,setRows]=useState(null), [error,setError]=useState(''), [revision,reload]=useState(0)
  const [confirming,setConfirming]=useState(false), [clearing,setClearing]=useState(false)
  const [feedback,setFeedback]=useState(''), [clearError,setClearError]=useState('')
  const {start,end}=period==='custom'?custom:recentPeriod(Number(period),today())
  const valid=start && end && start<=end
  useEffect(()=>{
    let current=true
    setRows(null)
    setError('')
    if(valid) rpc(db,'manage',{action:'history',p:{start,end}}).then(list=>{if(current)setRows(list)}).catch(e=>{if(current)setError(e.message)})
    return ()=>{current=false}
  },[db,start,end,valid,revision])
  const showCost=permitted(profile,'epi.financeiro')
  async function clearHistory() {
    setClearing(true)
    setClearError('')
    try {
      const result=await rpc(db,'manage',{action:'clear_history',p:{}})
      setFeedback(result.count ? `Limpeza concluída. Lançamentos removidos dos relatórios: ${result.count}.` : 'O histórico já está limpo.')
      setConfirming(false)
      reload(n=>n+1)
    } catch (e) {
      setClearError(e.message)
    } finally {
      setClearing(false)
    }
  }
  return <Panel title="Histórico de entradas e saídas" action={<div className="button-group">
    <button className="secondary" onClick={()=>reload(n=>n+1)}>Atualizar histórico</button>
    {showCost && !confirming && <button className="secondary" onClick={()=>{setConfirming(true);setFeedback('');setClearError('')}}>Limpar todo o histórico</button>}
  </div>}>
    {confirming && <div className="notice">
      <p>Limpar os lançamentos de todos os períodos {profile.is_master?'de todas as unidades':'no seu escopo de atendimento'}? A limpeza também retira esses valores do Financeiro. O saldo físico e as fichas de entrega serão preservados.</p>
      <div className="button-group"><button className="secondary" disabled={clearing} onClick={()=>{setConfirming(false);setClearError('')}}>Cancelar</button>
        <button className="primary" disabled={clearing} onClick={clearHistory}>{clearing?'Limpando…':'Confirmar limpeza'}</button></div>
      {clearError && <p role="alert">{clearError}</p>}
    </div>}
    {feedback && <p className="epi-success" role="status">{feedback}</p>}
    <div className="epi-filters">
      <Field label="Período"><select value={period} onChange={e=>{if(e.target.value==='custom')setCustom({start,end});setPeriod(e.target.value)}}>
        {[7,30,90,365].map(d=><option key={d} value={d}>Últimos {d} dias</option>)}<option value="custom">Personalizado</option>
      </select></Field>
      {period==='custom' && <><Field label="Data inicial" type="date" value={start} max={end} onChange={e=>setCustom({...custom,start:e.target.value})}/>
        <Field label="Data final" type="date" value={end} min={start} onChange={e=>setCustom({...custom,end:e.target.value})}/></>}
    </div>
    {!valid?<p role="alert">Informe um intervalo de datas válido.</p>:error?<p role="alert">{error}</p>:rows===null?<p role="status">Carregando movimentações…</p>:
      <Table headers={['Data','Movimentação','Material','Quantidade','Unidade','Colaborador','Projeto',...(showCost?['Valor total']:[])]}
        rows={rows.map(v=>[stamp(v.created_at),v.kind,variant(v.material_label || {}),v.qty,v.unit,v.employee,v.project,...(showCost?[money(v.total)]:[])])}
        empty="Nenhuma movimentação no período selecionado."/>}
  </Panel>
}
