import { Skeleton } from './Skeleton'
import React, {useEffect, useState} from 'react'
import { RefreshCw, Trash2, TriangleAlert } from 'lucide-react'
import {Panel, Field, Table, rpc} from './EpiShared'
import {today} from './data'
import {stamp, money, variant} from './epiData'
import {recentPeriod} from './reportFilters'
import {permitted} from './access'

export function StockHistory({db,profile}) {
  const [period,setPeriod]=useState('30'), [custom,setCustom]=useState(()=>recentPeriod(30,today()))
  const [result,setResult]=useState(null), [error,setError]=useState(''), [revision,reload]=useState(0)
  const [confirming,setConfirming]=useState(false), [clearing,setClearing]=useState(false)
  const [feedback,setFeedback]=useState(''), [clearError,setClearError]=useState('')
  const {start,end}=period==='custom'?custom:recentPeriod(Number(period),today())
  const valid=start && end && start<=end
  const rows=result?.start===start && result?.end===end ? result.rows : null
  useEffect(()=>{
    let current=true
    setError('')
    if(valid) rpc(db,'manage',{action:'history',p:{start,end}}).then(rows=>{if(current)setResult({start,end,rows})}).catch(e=>{if(current)setError(e.message)})
    return ()=>{current=false}
  },[db,start,end,valid,revision])
  const showCost=permitted(profile,'epi.financeiro')
  async function clearHistory() {
    setClearing(true)
    setClearError('')
    try {
      const result=await rpc(db,'manage',{action:'clear_history',p:{}})
      setFeedback(result.count ? `Limpeza concluída. Movimentações removidas do histórico: ${result.count}.` : 'O histórico já está limpo.')
      setConfirming(false)
      setResult(null)
      reload(n=>n+1)
    } catch (e) {
      setClearError(e.message)
    } finally {
      setClearing(false)
    }
  }
  return <Panel title="Histórico de entradas e saídas" action={<div className="button-group">
    <button className="secondary" onClick={()=>reload(n=>n+1)}><RefreshCw size={15} aria-hidden="true"/> Atualizar histórico</button>
    {permitted(profile,'epi.historico') && !confirming && <button className="btn-outline-danger" onClick={()=>{setConfirming(true);setFeedback('');setClearError('')}}><Trash2 size={15} aria-hidden="true"/> Limpar todo o histórico</button>}
  </div>}>
    {confirming && <div className="notice">
      <p>Limpar os lançamentos de todos os períodos {profile.is_master?'de todas as unidades':'no seu escopo de atendimento'}? A aba financeira, o saldo físico e as fichas de entrega serão preservados.</p>
      <div className="button-group"><button className="secondary" disabled={clearing} onClick={()=>{setConfirming(false);setClearError('')}}>Cancelar</button>
        <button className="primary" disabled={clearing} onClick={clearHistory}>{clearing?'Limpando…':'Confirmar limpeza'}</button></div>
      {clearError && <p role="alert">{clearError}</p>}
    </div>}
    {feedback && <p className="epi-success" role="status">{feedback}</p>}
    <div className="epi-filters epi-history-filters">
      <Field label="Período" className="epi-period-field"><select value={period} onChange={e=>{if(e.target.value==='custom')setCustom({start,end});setPeriod(e.target.value)}}>
        {[7,30,90,365].map(d=><option key={d} value={d}>Últimos {d} dias</option>)}<option value="custom">Personalizado</option>
      </select></Field>
      {period==='custom' && <><Field label="Data inicial" type="date" value={start} max={end} onChange={e=>setCustom({...custom,start:e.target.value})}/>
        <Field label="Data final" type="date" value={end} min={start} onChange={e=>setCustom({...custom,end:e.target.value})}/></>}
    </div>
    {!valid?<p role="alert">Informe um intervalo de datas válido.</p>:error?(
      <div className="epi-warning-box" role="alert">
        <span className="epi-warning-icon"><TriangleAlert size={22} aria-hidden="true"/></span>
        <div>
          <strong>Não foi possível carregar o histórico</strong>
          <p>{error === 'Failed to fetch' ? 'Tente atualizar para consultar as movimentações.' : error}</p>
        </div>
      </div>
    ):rows===null?<Skeleton label="Carregando movimentações…"/>:
      <Table headers={['Data','Movimentação','Material','Quantidade','Unidade','Colaborador','Projeto',...(showCost?['Valor total']:[])]}
        rows={rows.map(v=>[stamp(v.created_at),<span className={'badge '+(v.kind==='Entrada'?'green':'gray')}>{v.kind}</span>,<strong className="material-strong">{variant(v.material_label || {})}</strong>,v.qty,v.unit,v.employee||'—',v.project||'—',...(showCost?[<strong className="money-strong">{money(v.total)}</strong>]:[])])}
        empty="Nenhuma movimentação no período selecionado."/>}
  </Panel>
}
