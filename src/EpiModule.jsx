import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  Boxes,
  ClipboardList,
  Wallet,
  Truck,
  Archive,
  FileText,
  Hourglass,
  PackageCheck,
  ClipboardCheck,
  X,
} from 'lucide-react'
import { Skeleton } from './Skeleton'
import { Stock } from './EpiStock'
import { StockHistory } from './StockHistory'
import { Sheet } from './EpiSheet'
import { Logistics } from './EpiLogistics'
import { Consolidated } from './EpiReports'
import { Requests, Finance } from './EpiOperations'
import { rpc } from './EpiShared'
import './epi.css'
import './epi-sheet.css'
import { epiSections, permitted } from './access'

const tabs = [
  ['Estoque', Boxes],
  ['Estoque Consolidado', Boxes],
  ['Solicitações', ClipboardList],
  ['Financeiro', Wallet],
  ['Correios', Truck],
  ['Histórico de movimentações', Archive],
]
export default function EpiModule({ db, profile, employees, initialTab = 'Estoque', initialFocus, onTab, onChange }) {
  const [selected, setTab] = useState(initialTab),
    [data, setData] = useState(null),
    [error, setError] = useState(''),
    [message, setMessage] = useState('')
  const [sheetRequest, setSheetRequest] = useState(null)
  const [sheetOpen, setSheetOpen] = useState(false)
  const canSheet = permitted(profile, 'epi.ficha')
  const visible = tabs.filter(([label]) => (label==='Solicitações' && canSheet) || permitted(profile, 'epi.' + (label==='Estoque Consolidado'?'estoque':epiSections[label])))
  const tab = visible.some(([label]) => label === selected) ? selected : visible[0]?.[0]
  const revision = useRef(0)
  const refresh = useCallback(async () => {
    const version = ++revision.current
    try {
      const next = await rpc(db, 'workspace', {})
      if (version !== revision.current) return
      if (!next && !['Correios','Histórico de movimentações'].includes(tab)) throw new Error('Perfil sem acesso ao módulo de EPI.')
      setData(next)
      setError('')
    } catch (e) {
      if (version === revision.current) setError(e.message)
    }
  }, [db, tab])
  useEffect(() => {
    refresh()
    window.addEventListener('focus', refresh)
    return () => {
      revision.current++
      window.removeEventListener('focus', refresh)
    }
  }, [refresh, tab])
  async function save(action, p) {
    setMessage('')
    const result = await rpc(db, 'manage', { action, p })
    await refresh()
    if (action === 'deliver' || action === 'cancel') onChange?.()
    setMessage(
      action === 'deliver'
        ? 'Entrega confirmada. Estoque, ficha e despesa atualizados.'
        : action === 'cancel'
          ? 'Pedido cancelado e reserva liberada.'
          : 'Registro salvo.',
    )
    return result
  }
  const props = { data, profile, employees, save, initialFocus:tab===initialTab?initialFocus:null }
  const requests = data?.requests?.filter(q => !q.list_removed) || []
  const month = new Date().toLocaleDateString('en-CA', {timeZone:'America/Sao_Paulo'}).slice(0,7)
  const indicators = [
    ['Solicitações abertas', requests.filter(q=>q.status==='Solicitado').length, FileText],
    ['Aguardando aprovação', requests.filter(q=>q.status==='Solicitado' && q.stage==='Aguardando aprovação do projeto').length, Hourglass],
    ['Entregas no mês', requests.filter(q=>q.status==='Entregue' && q.closed_at && new Date(q.closed_at).toLocaleDateString('en-CA',{timeZone:'America/Sao_Paulo'}).slice(0,7)===month).length, PackageCheck],
    ['Solicitações entregues', requests.filter(q=>q.status==='Entregue').length, ClipboardCheck],
  ]
  return (
    <div className="epi">
      {data && permitted(profile,'epi.solicitacoes') && (
        <div className="epi-indicators">
          {indicators.map(([label,value,Icon])=>(
            <div className="epi-indicator" key={label}>
              <span className="epi-indicator-icon"><Icon size={22}/></span>
              <div><span>{label}</span><strong>{value}</strong></div>
            </div>
          ))}
        </div>
      )}
      <div className="epi-bar">
        <nav aria-label="Seções de EPI">
          {visible.map(([name, I]) => (
            <button
              key={name}
              className={tab === name ? 'selected' : ''}
              aria-current={tab === name ? 'page' : undefined}
              onClick={() => {
                setTab(name)
                onTab?.(name)
                setMessage('')
              }}
            >
              <I size={15} />
              {name}
            </button>
          ))}
        </nav>
        {canSheet && (
          <button className="primary" onClick={()=>{setSheetRequest(null);setSheetOpen(true)}}>
            <FileText size={16}/> Emitir ficha
          </button>
        )}
      </div>
      {message && (
        <p role="status" className="epi-success">
          {message}
        </p>
      )}
      {error && (
        <div className="notice error" role="alert">
          {error}
          <button onClick={refresh}>Tentar novamente</button>
        </div>
      )}
      <div className="epi-tab-content" key={tab}>
        {tab === 'Histórico de movimentações' ? (
          <StockHistory db={db} profile={profile}/>
        ) : tab==='Correios' ? (
          <Logistics db={db} profile={profile} shipping/>
        ) : !data || !profile ? (
          !error && <Skeleton label="Carregando o módulo de EPI…"/>
        ) : (
          <>
            {tab === 'Estoque' && <Stock {...props} db={db} />}
            {tab === 'Solicitações' && permitted(profile,'epi.solicitacoes') && (
              <div className="epi-requests-layout">
                <Requests
                  {...props}
                  onSheet={canSheet ? request=>{setSheetRequest({...request});setSheetOpen(true)} : null}
                  refresh={refresh}
                />
                <aside className="epi-summary card">
                  <h2>Resumo de solicitações</h2>
                  {indicators.map(([label,value])=>(
                    <div key={label}><span>{label}</span><strong>{value}</strong></div>
                  ))}
                  {visible.some(([name])=>name==='Estoque') && (
                    <button className="secondary" onClick={()=>{setTab('Estoque');onTab?.('Estoque')}}>
                      Consultar estoque →
                    </button>
                  )}
                </aside>
              </div>
            )}
            {tab === 'Financeiro' && <Finance {...props}><Logistics db={db} profile={profile} onSaved={refresh}/></Finance>}
            {tab === 'Estoque Consolidado' && <Consolidated data={data} db={db} />}
          </>
        )}
      </div>

      {/* Modal Moderno com Pré-visualização da Ficha na Lateral */}
      {canSheet && sheetOpen && (
        <div
          className="epi-sheet-overlay"
          role="presentation"
          onClick={(e)=>{if(e.target===e.currentTarget) setSheetOpen(false)}}
        >
          <div className="epi-sheet-modal" role="dialog" aria-modal="true" aria-label="Emitir ficha de EPI">
            <header className="epi-sheet-modal-header">
              <div>
                <h2>Ficha de Controle de EPI</h2>
                <small>Emissão, histórico e termo de responsabilidade com visualização em tempo real</small>
              </div>
              <button className="secondary epi-sheet-close-btn" onClick={()=>setSheetOpen(false)} aria-label="Fechar modal">
                <X size={18}/> Fechar
              </button>
            </header>
            <div className="epi-sheet-modal-content">
              <Sheet
                sheetRequest={data?.requests?.find(q=>q.id===sheetRequest?.id && !q.list_removed && q.status!=='Cancelado')}
                clearRequest={()=>setSheetRequest(null)}
                {...props}
                db={db}
                onIssued={() => {refresh(); onChange?.()}}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
