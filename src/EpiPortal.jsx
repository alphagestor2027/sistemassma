import React, { useEffect, useRef, useState } from 'react'
import { HardHat, ClipboardList } from 'lucide-react'
import { Panel, Select, Field, Table, rpc } from './EpiShared'
import { stamp, variant } from './epiData'
import './epi.css'

export default function EpiPortal({ db }) {
  const [token, setToken] = useState(() => new URLSearchParams(location.hash.slice(1)).get('acesso') || '')
  const [sessionReady, setReady] = useState(false),
    [signed, setSigned] = useState('')
  const [employee, setEmployee] = useState(''),
    [state, setState] = useState(''),
    [names, setNames] = useState([]),
    [states, setStates] = useState([])
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
    const { data } = db.auth.onAuthStateChange((_event, s) => {
      setSigned(s?.user.id || '')
      setReady(true)
    })
    return () => data.subscription.unsubscribe()
  }, [db])
  useEffect(() => {
    let active = true
    if (!sessionReady) return
    if (!token && !signed) {
      setContext(null)
      setNames([])
      setStates([])
      setEmployee('')
      setState('')
      setCounts({})
      setMessage('')
      setLoading(false)
      return
    }
    setError('')
    setLoading(true)
    setContext(null)
    const action = state ? 'context' : employee ? 'states' : 'names'
    rpc(db, 'portal', { action, p: { token, employee_id: employee, state } })
      .then((result) => {
        if (!active) return
        if (action === 'names') setNames(result)
        else if (action === 'states') setStates(result)
        else setContext(result)
      })
      .catch((e) => {
        if (active) setError(e.message)
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [db, employee, state, token, refresh, signed, sessionReady])
  function reset() {
    setEmployee('')
    setState('')
    setContext(null)
    setStates([])
    setNames([])
    setCounts({})
    setMessage('')
    setError('')
    formKey.current = null
  }
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
        p: { id: formKey.current, employee_id: employee, state, token, items },
      })
      setMessage(
        'Solicitação ' + id.slice(0, 8).toUpperCase() + ' registrada. Acompanhe a entrega no histórico.',
      )
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
        <span>Portal do colaborador</span>
      </header>
      <main>
        <div className="page-heading">
          <div>
            <h1>Solicitação de EPI</h1>
            <p>Escolha os equipamentos para sua próxima entrega.</p>
          </div>
          <ClipboardList size={34} />
        </div>
        {!token && !signed && sessionReady ? (
          <Panel title="Acesso individual">
            <form
              className="epi-access"
              onSubmit={(e) => {
                e.preventDefault()
                reset()
                const code = new FormData(e.currentTarget).get('code').trim()
                setToken(code)
                history.replaceState(null, '', '#acesso=' + encodeURIComponent(code))
              }}
            >
              <Field
                label="Código de acesso"
                name="code"
                required
                autoComplete="off"
                placeholder="Código fornecido pelo responsável de SSMA"
              />
              <button className="primary">Acessar</button>
            </form>
          </Panel>
        ) : (
          <Panel title="Identificação">
            <div className="epi-fields">
              <Select
                label="Nome do colaborador"
                value={employee}
                disabled={busy || !names.length}
                options={names.map((n) => [n.id, n.name])}
                onChange={(e) => {
                  setEmployee(e.target.value)
                  setStates([])
                  setState('')
                  setContext(null)
                  setCounts({})
                  setMessage('')
                  formKey.current = null
                }}
              />
              <Select
                label="Estado"
                value={state}
                options={states}
                disabled={busy || !employee || !states.length}
                onChange={(e) => {
                  setState(e.target.value)
                  setContext(null)
                  setCounts({})
                  setMessage('')
                  formKey.current = null
                }}
              />
            </div>
            {!loading && !error && sessionReady && !names.length && (
              <p className="epi-empty">Nenhum colaborador ativo com regional vinculada para este acesso.</p>
            )}
          </Panel>
        )}
        {loading && (
          <p role="status" className="notice">
            Consultando o estoque e os vínculos…
          </p>
        )}
        {message && (
          <p role="status" className="epi-success">
            {message}
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
            <section className="epi-context">
              {[
                ['Projeto', context.project],
                ['Cargo', context.job],
                ['Técnico de segurança', context.technician],
                ['Regional', context.region],
              ].map(([label, v]) => (
                <div key={label}>
                  <small>{label}</small>
                  <strong>{v}</strong>
                </div>
              ))}
            </section>
            <Panel
              title="Materiais disponíveis"
              action={
                <button
                  type="button"
                  className="text-button"
                  disabled={busy}
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
                          disabled={busy}
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
                  <div className="epi-submit">
                    <button className="primary" disabled={busy || !Object.values(counts).some((n) => n > 0)}>
                      {busy ? 'Enviando…' : 'Enviar solicitação'}
                    </button>
                  </div>
                </form>
              ) : (
                <p className="epi-empty">Não há material disponível no estoque desta regional.</p>
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
        {token && (
          <button
            className="text-button"
            disabled={busy}
            onClick={() => {
              reset()
              setToken('')
              history.replaceState(null, '', location.pathname)
            }}
          >
            Trocar código de acesso
          </button>
        )}
      </main>
    </div>
  )
}
