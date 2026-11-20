import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  Boxes,
  ClipboardList,
  Wallet,
  FileText,
  FlaskConical,
  MapPin,
  CalendarDays,
  Archive,
  ExternalLink,
} from 'lucide-react'
import { Stock, Regions, Planning } from './EpiStock'
import { Requests, Finance, Sheet, Tests } from './EpiOperations'
import { rpc } from './EpiShared'
import './epi.css'

const tabs = [
  ['Estoque', Boxes],
  ['Solicitações', ClipboardList],
  ['Financeiro', Wallet],
  ['Ficha digital', FileText],
  ['Ensaios e retornos', FlaskConical],
  ['Previsão de compras', CalendarDays],
  ['Regionais e vínculos', MapPin],
  ['Registros anteriores', Archive],
]
export default function EpiModule({ db, profile, employees, children, initialTab = 'Estoque', onChange }) {
  const [tab, setTab] = useState(initialTab),
    [data, setData] = useState(null),
    [error, setError] = useState(''),
    [message, setMessage] = useState('')
  const revision = useRef(0)
  const refresh = useCallback(async () => {
    const version = ++revision.current
    try {
      const next = await rpc(db, 'workspace', {})
      if (version !== revision.current) return
      if (!next) throw new Error('Perfil sem acesso ao módulo de EPI.')
      setData(next)
      setError('')
    } catch (e) {
      if (version === revision.current) setError(e.message)
    }
  }, [db])
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
  const props = { data, profile, employees, save }
  return (
    <div className="epi">
      <div className="epi-bar">
        <nav aria-label="Seções de EPI">
          {tabs.map(([name, I]) => (
            <button
              key={name}
              className={tab === name ? 'selected' : ''}
              aria-current={tab === name ? 'page' : undefined}
              onClick={() => {
                setTab(name)
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
      {tab === 'Registros anteriores' ? (
        children
      ) : !data || !profile ? (
        !error && <p className="notice">Carregando o módulo de EPI…</p>
      ) : (
        <>
          {tab === 'Estoque' && <Stock {...props} />}{' '}
          {tab === 'Solicitações' && <Requests {...props} refresh={refresh} />}{' '}
          {tab === 'Financeiro' && <Finance {...props} />}
          {tab === 'Ficha digital' && <Sheet {...props} />}{' '}
          {tab === 'Ensaios e retornos' && <Tests {...props} />}{' '}
          {tab === 'Previsão de compras' && <Planning {...props} />}
          {tab === 'Regionais e vínculos' && <Regions {...props} />}
        </>
      )}
    </div>
  )
}
