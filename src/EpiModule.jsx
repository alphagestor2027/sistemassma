import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  Boxes,
  ClipboardList,
  Wallet,
  FileText,
  Truck,
  Archive,
  ExternalLink,
} from 'lucide-react'
import { Skeleton } from './Skeleton'
import { Stock } from './EpiStock'
import { StockHistory } from './StockHistory'
import { Sheet } from './EpiSheet'
import {Logistics} from './EpiLogistics'
import {Consolidated} from './EpiReports'
import { Requests, Finance } from './EpiOperations'
import { rpc } from './EpiShared'
import './epi.css'
import { epiSections, permitted } from './access'

const tabs = [
  ['Estoque', Boxes],
  ['Estoque Consolidado', Boxes],
  ['Solicitações', ClipboardList],
  ['Financeiro', Wallet],
  ['Ficha digital', FileText],
  ['Correios', Truck],
  ['Histórico de movimentações', Archive],
]
export default function EpiModule({ db, profile, employees, initialTab = 'Estoque', initialFocus, onTab, onChange }) {
  const [selected, setTab] = useState(initialTab),
    [data, setData] = useState(null),
    [error, setError] = useState(''),
    [message, setMessage] = useState('')
  const visible = tabs.filter(([label]) => permitted(profile, 'epi.' + (label==='Estoque Consolidado'?'estoque':epiSections[label])))
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
  return (
    <div className="epi">
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
              <I size={16} />
              {name}
            </button>
          ))}
        </nav>
        <a className="secondary" href="/emissaoepi" target="_blank" rel="noreferrer">
          Solicitar EPI <ExternalLink size={15} />
        </a>
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
        ) : tab==='Correios' ? <Logistics db={db} profile={profile} shipping/> : !data || !profile ? (
          !error && <Skeleton label="Carregando o módulo de EPI…"/>
        ) : (
          <>
            {tab === 'Estoque' && <Stock {...props} db={db} />}{' '}
            {tab === 'Solicitações' && <Requests {...props} refresh={refresh} />}{' '}
            {tab === 'Financeiro' && <><Finance {...props} /><Logistics db={db} profile={profile} onSaved={refresh}/></>}
            {tab === 'Ficha digital' && <Sheet {...props} db={db} onIssued={() => {refresh(); onChange?.()}} />}{' '}
            {tab === 'Estoque Consolidado' && <Consolidated data={data} db={db} />}{' '}
          </>
        )}
      </div>
    </div>
  )
}
