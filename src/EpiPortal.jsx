import {Assistant} from './Assistant'
import { Skeleton } from './Skeleton'
import {ThemeToggle} from './ThemeToggle'
import {NameTracking} from './NameTracking'
import { ReplacementAlert } from './EpiIndicators'
import React, { useEffect, useRef, useState } from 'react'
import { HardHat, ClipboardList } from 'lucide-react'
import { Panel, Select, Field, Table, rpc } from './EpiShared'
import { stamp, variant } from './epiData'
import './epi.css'

export default function EpiPortal({ db }) {
  const [code, setCode] = useState('')
  const [tracking, setTracking] = useState(null),
    [trackingError, setTrackingError] = useState(''),
    [checking, setChecking] = useState(false)
  async function track(e) {
    e.preventDefault()
    setChecking(true)
    setTrackingError('')
    setTracking(null)
    try {
      setTracking(await rpc(db, 'portal', { action: 'track', p: { code } }))
    } catch (err) {
      setTrackingError(err.message)
    } finally {
      setChecking(false)
    }
  }
  const [employee, setEmployee] = useState(''),
    [names, setNames] = useState([])
  const nameOptions=React.useMemo(()=>{
    const seen=new Set(),duplicates=new Set()
    for(const n of names){if(seen.has(n.name))duplicates.add(n.name);seen.add(n.name)}
    return names.map(n=>[n.id,duplicates.has(n.name)?n.name+' · '+n.project:n.name])
  },[names])
  const [context, setContext] = useState(null),
    [counts, setCounts] = useState({}),
    [error, setError] = useState(''),
    [message, setMessage] = useState('')
  const [refresh, setRefresh] = useState(0),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(false)
  const formKey = useRef(null),
    lock = useRef(false)
  useEffect(() => {
    let active = true
    setError('')
    setLoading(true)
    const action = employee ? 'context' : 'names'
    rpc(db, 'portal', { action, p: { employee_id: employee } })
      .then((result) => {
        if (!active) return
        if (action === 'names') setNames(result)
        else setContext(result)
      })
      .catch((e) => {
        if (active) {setContext(null);setError(e.message)}
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [db, employee, refresh])
  async function send(e) {
    e.preventDefault()
    if (lock.current) return
    const items = Object.entries(counts)
      .filter(([, qty]) => qty > 0)
      .map(([id, qty]) => ({ id, qty }))
    if (!items.length) return
    lock.current = true
    setBusy(true)
    setError('')
    setMessage('')
    formKey.current ??= crypto.randomUUID()
    try {
      const id = await rpc(db, 'portal', {
        action: 'submit',
        p: { id: formKey.current, employee_id: employee, items },
      })
      setMessage(id)
      setCode('')
      setTracking(null)
      setTrackingError('')
      formKey.current = null
      setCounts({})
      setRefresh((n) => n + 1)
    } catch (err) {
      setError(err.message)
    } finally {
      lock.current = false
      setBusy(false)
    }
  }
  return (
    <div className="epi-portal">
      <header className="epi-mast">
        <div>
          <span className="brand-mark">
            <HardHat aria-hidden />
          </span>
          <strong>
            Sistema SSMA <b>2.0</b>
          </strong>
        </div>
        <div><span>Portal do colaborador</span><Assistant db={db} page="portal"/><ThemeToggle/></div>
      </header>
      <main>
        <div className="page-heading">
          <div>
            <h1>Solicitação de EPI</h1>
            <p>Escolha os equipamentos para sua próxima entrega.</p>
          </div>
          <ClipboardList size={34} />
        </div>
        <Panel title="Identificação">
          <div className="epi-fields">
            <Select
              label="Nome do colaborador"
              value={employee}
              disabled={busy || !names.length}
              options={nameOptions}
              onChange={(e) => {
                setEmployee(e.target.value)
                setContext(null)
                setCounts({})
                setMessage('')
                formKey.current = null
              }}
            />
          </div>
          <p className="epi-help">Se o seu nome não estiver na lista, entre em contato com o SSMA.</p>
        </Panel>
        {loading && !context && (
          <Skeleton layout={employee?'table':'compact'} label={employee?'Consultando o estoque e os vínculos…':'Carregando colaboradores…'}/>
        )}
        {message && (
          <p role="status" className="epi-success">
            Pedido recebido. Guarde este código para acompanhar a solicitação. Ele é exibido apenas nesta confirmação. <strong data-testid="receipt-code">{message}</strong>
          </p>
        )}
        {error && (
          <div className="notice error" role="alert">
            {error}
            <button onClick={() => setRefresh((n) => n + 1)}>Atualizar</button>
          </div>
        )}
        {context && (
          <>
            <ReplacementAlert requests={context.history} />
            <section className="epi-context">
              {[
                ['Projeto', context.project],
                ['Cargo', context.job],
                ['Gerência',context.management],['Coordenador',context.coordinator],
                ...(context.registration?[['Matrícula',context.registration]]:context.cpf_masked?[['CPF',context.cpf_masked]]:[]),
                ['Região',context.area],
                ['Técnico de segurança', context.technician],
              ].map(([label, v]) => (
                <div key={label}>
                  <small>{label}</small>
                  <strong>{v || 'A definir'}</strong>
                </div>
              ))}
            </section>
            <Panel
              title="Materiais disponíveis"
              action={
                <button
                  type="button"
                  className="text-button"
                  disabled={busy || loading}
                  onClick={() => {
                    setCounts({})
                    formKey.current = null
                    setRefresh((n) => n + 1)
                  }}
                >
                  Atualizar estoque
                </button>
              }
            >
              {context.materials.length ? (
                <form onSubmit={send}>
                  <div className="epi-pick">
                    {context.materials.map((m) => (
                      <label key={m.id}>
                        <div>
                          <strong>{variant(m)}</strong>
                          <small>
                            {m.ca ? 'CA ' + m.ca : 'Sem CA'} · {m.available} disponíveis
                          </small>
                        </div>
                        <input
                          type="number"
                          aria-label={'Quantidade de ' + variant(m)}
                          min="0"
                          max={m.available}
                          step="1"
                          placeholder="0"
                          disabled={busy || loading}
                          value={counts[m.id] ?? ''}
                          onChange={(e) => {
                            formKey.current = null
                            setCounts({
                              ...counts,
                              [m.id]: e.target.value === '' ? '' : Number(e.target.value),
                            })
                          }}
                        />
                      </label>
                    ))}
                  </div>
                  <p className="epi-help">Ao enviar, guarde o código de rastreio. Ele aparece uma única vez na confirmação.</p>
                  <div className="epi-submit">
                    <button className="primary" aria-busy={busy} disabled={busy || loading || !Object.values(counts).some((n) => n > 0)}>
                      {busy ? 'Enviando…' : 'Enviar solicitação'}
                    </button>
                  </div>
                </form>
              ) : (
                <p className="epi-empty">Não há material disponível para o seu projeto no estoque do técnico responsável.</p>
              )}
            </Panel>
            <Panel title="Histórico de solicitações">
              <Table
                headers={['Data', 'Projeto / UF', 'Materiais', 'Situação']}
                rows={context.history.map((q) => [
                  stamp(q.date),
                  q.project + ' / ' + q.state,
                  q.items.map((i) => i.qty + ' × ' + variant(i)).join(', '),
                  q.status,
                ])}
                empty="Você ainda não tem solicitações registradas."
              />
            </Panel>
          </>
        )}
        <Panel title="Acompanhar um pedido">
          <form className="epi-access" onSubmit={track}>
            <Field
              label="Código de rastreio do pedido"
              required
              maxLength={64}
              value={code}
              disabled={checking}
              onChange={(e) => {
                setCode(e.target.value)
                setTracking(null)
                setTrackingError('')
              }}
              placeholder="EPI-…"
            />
            <button className="secondary" disabled={checking}>
              {checking ? 'Consultando…' : 'Consultar andamento'}
            </button>
          </form>
          {checking && <Skeleton layout="compact" label="Consultando andamento…"/>}
          <NameTracking db={db}/>
          {trackingError && (
            <p role="alert" className="form-error">
              {trackingError}
            </p>
          )}
          {tracking && (
            <div aria-live="polite">
              <p className="epi-help">
                Situação atual: <strong>{tracking.stage}</strong>
              </p>
              {tracking.postal && (
                <p>
                  Rastreamento dos Correios: <strong>{tracking.postal}</strong>
                </p>
              )}
              <Table
                headers={['Data', 'Andamento']}
                rows={tracking.events.map((ev) => [stamp(ev.date), ev.stage])}
              />
            </div>
          )}
        </Panel>
      </main>
    </div>
  )
}
