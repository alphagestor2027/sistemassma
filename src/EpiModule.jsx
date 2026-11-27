import React, { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Boxes,
  ClipboardList,
  Wallet,
  Truck,
  Archive,
  FileText,
  Inbox,
  Hourglass,
  Send,
  ClipboardCheck,
  X,
} from 'lucide-react'
import { Skeleton } from './Skeleton'
import { Stock } from './EpiStock'
import { StockHistory } from './StockHistory'
import { Sheet, RequestSheetPreview } from './EpiSheet'
import { Logistics } from './EpiLogistics'
import { Consolidated } from './EpiReports'
import { Requests, Finance, normalizeRequestStage } from './EpiOperations'
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
    [message, setMessage] = useState(''),
    [requestFilter, setRequestFilter] = useState('')
  const [previewRequest, setPreviewRequest] = useState(null)
  const [sheetOpen, setSheetOpen] = useState(false)
  const canSheet = permitted(profile, 'epi.ficha')
  const visible = tabs.filter(
    ([label]) =>
      (label === 'Solicitações' && canSheet) ||
      permitted(profile, 'epi.' + (label === 'Estoque Consolidado' ? 'estoque' : epiSections[label])),
  )
  const tab = visible.some(([label]) => label === selected) ? selected : visible[0]?.[0]
  const revision = useRef(0)
  const refresh = useCallback(async () => {
    const version = ++revision.current
    try {
      const next = await rpc(db, 'workspace', {})
      if (version !== revision.current) return
      if (!next && !['Correios', 'Histórico de movimentações'].includes(tab))
        throw new Error('Perfil sem acesso ao módulo de EPI.')
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
    if (
      [
        'deliver',
        'cancel',
        'progress',
        'toggle_signed',
        'entry',
        'material',
        'edit_material',
        'delete_material',
        'edit_request',
        'remove_request',
        'clear_requests',
      ].includes(action)
    )
      onChange?.()
    setMessage(
      action === 'deliver' || (action === 'progress' && p?.stage === 'Concluída')
        ? 'Solicitação concluída. Estoque, ficha e despesa atualizados.'
        : action === 'cancel'
          ? 'Pedido cancelado e reserva liberada.'
          : action === 'remove_request'
            ? 'Ficha / solicitação removida e saldo do estoque atualizado automaticamente.'
            : action === 'edit_request'
              ? 'Ficha / solicitação alterada e saldo do estoque atualizado automaticamente.'
              : action === 'toggle_signed'
                ? result?.signed
                  ? 'Ficha validada como Assinada.'
                  : 'Marcação de assinatura removida.'
                : 'Registro salvo.',
    )
    return result
  }
  const [headingHost, setHeadingHost] = useState(null)
  useEffect(() => {
    setHeadingHost(document.getElementById('epi-heading-action'))
  }, [])
  const props = { data, profile, employees, save, refresh, onChange, initialFocus: tab === initialTab ? initialFocus : null }
  const requests = data?.requests?.filter((q) => !q.list_removed) || []

  const requestIndicators = [
    [
      'Solicitações recebidas',
      requests.filter((q) => normalizeRequestStage(q) === 'Solicitações recebidas').length,
      Inbox,
      'red',
    ],
    [
      'Para Aprovação do Gestor',
      requests.filter((q) => normalizeRequestStage(q) === 'Para Aprovação do Gestor').length,
      Hourglass,
      'amber',
    ],
    [
      'Em Separação',
      requests.filter((q) => normalizeRequestStage(q) === 'Em Separação').length,
      Boxes,
      'blue',
    ],
    [
      'Enviada',
      requests.filter((q) => normalizeRequestStage(q) === 'Enviada').length,
      Send,
      'violet',
    ],
    [
      'Concluída',
      requests.filter((q) => normalizeRequestStage(q) === 'Concluída').length,
      ClipboardCheck,
      'green',
    ],
  ]

  const emitBtn = canSheet && (
    <button
      className="primary epi-emit-btn"
      onClick={() => {
        setPreviewRequest(null)
        setSheetOpen(true)
      }}
    >
      <FileText size={16} aria-hidden="true" /> Emitir ficha
    </button>
  )
  return (
    <div className="epi">
      {headingHost && emitBtn && createPortal(emitBtn, headingHost)}
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
              <I size={15} aria-hidden="true" />
              {name}
            </button>
          ))}
        </nav>
        {!headingHost && emitBtn}
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
          <StockHistory db={db} profile={profile} />
        ) : tab === 'Correios' ? (
          <Logistics db={db} profile={profile} shipping />
        ) : !data || !profile ? (
          !error && <Skeleton label="Carregando o módulo de EPI…" />
        ) : (
          <>
            {tab === 'Estoque' && <Stock {...props} db={db} />}
            {tab === 'Solicitações' && permitted(profile, 'epi.solicitacoes') && (
              <>
                <div className="epi-indicators epi-indicators-5" role="region" aria-label="Indicadores de solicitações">
                  {requestIndicators.map(([label, value, Icon, tone]) => {
                    const active = requestFilter === label
                    return (
                      <button
                        type="button"
                        key={label}
                        className={'epi-indicator epi-indicator-btn tone-' + tone + (active ? ' is-active' : '')}
                        onClick={() => setRequestFilter(active ? '' : label)}
                        title={active ? 'Limpar filtro de status' : 'Filtrar por ' + label}
                      >
                        <span className="epi-indicator-icon">
                          <Icon size={22} aria-hidden="true" />
                        </span>
                        <div>
                          <span>{label}</span>
                          <strong>{value}</strong>
                        </div>
                      </button>
                    )
                  })}
                </div>
                <div className="epi-requests-layout">
                  <Requests
                    {...props}
                    externalStatus={requestFilter}
                    onExternalStatus={setRequestFilter}
                    onSheet={
                      canSheet
                        ? (request) => {
                            setSheetOpen(false)
                            setPreviewRequest({ ...request })
                          }
                        : null
                    }
                    refresh={refresh}
                  />
                  <aside className="epi-summary card">
                    <h2>Resumo de solicitações</h2>
                    <div className="epi-summary-list">
                      {requestIndicators.map(([label, value, Icon, tone]) => (
                        <div className="epi-summary-item" key={label}>
                          <span className={'epi-summary-icon tone-' + tone}>
                            <Icon size={16} aria-hidden="true" />
                          </span>
                          <span className="epi-summary-label">{label}</span>
                          <strong>{value}</strong>
                        </div>
                      ))}
                    </div>
                    {visible.some(([name]) => name === 'Estoque') && (
                      <button
                        className="epi-summary-cta"
                        onClick={() => {
                          setTab('Estoque')
                          onTab?.('Estoque')
                        }}
                      >
                        Consultar estoque →
                      </button>
                    )}
                  </aside>
                </div>
              </>
            )}
            {tab === 'Financeiro' && (
              <Finance {...props}>
                <Logistics db={db} profile={profile} onSaved={refresh} />
              </Finance>
            )}
            {tab === 'Estoque Consolidado' && <Consolidated data={data} db={db} />}
          </>
        )}
      </div>

      {/* Modal Completo (botão Emitir ficha: emissão, histórico, edição e exclusão de fichas) */}
      {canSheet && sheetOpen && (
        <div
          className="epi-sheet-overlay"
          role="presentation"
          onClick={(e) => {
            if (e.target === e.currentTarget) setSheetOpen(false)
          }}
        >
          <div className="epi-sheet-modal" role="dialog" aria-modal="true" aria-label="Emitir ficha de EPI">
            <header className="epi-sheet-modal-header">
              <div>
                <h2>Ficha de Controle de EPI</h2>
                <small>Emissão, histórico, edição de itens e termo de responsabilidade com visualização em tempo real</small>
              </div>
              <button className="secondary epi-sheet-close-btn" onClick={() => setSheetOpen(false)} aria-label="Fechar modal">
                <X size={18} /> Fechar
              </button>
            </header>
            <div className="epi-sheet-modal-content">
              <Sheet
                sheetRequest={null}
                clearRequest={() => {}}
                {...props}
                db={db}
                onIssued={() => {
                  refresh()
                  onChange?.()
                }}
              />
            </div>
          </div>
        </div>
      )}

      {/* Modal Somente Pré-visualização (ao clicar em "Abrir ficha de EPI" na solicitação) */}
      {canSheet && previewRequest && (
        <RequestSheetPreview
          db={db}
          request={data?.requests?.find((q) => q.id === previewRequest.id) || previewRequest}
          onClose={() => setPreviewRequest(null)}
        />
      )}
    </div>
  )
}
