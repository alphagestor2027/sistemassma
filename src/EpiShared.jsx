import React, { useRef, useState } from 'react'

export function Field({ label, icon, className = '', children, ...props }) {
  return (
    <label className={'epi-field' + (className ? ' ' + className : '')}>
      <span>{label}</span>
      {children || (
        icon ? (
          <span className="epi-input-wrap">
            {icon}
            <input {...props} />
          </span>
        ) : (
          <input {...props} />
        )
      )}
    </label>
  )
}
export function Select({ label, options, placeholder = 'Selecione', className = '', ...props }) {
  return (
    <Field label={label} className={className}>
      <select aria-label={label} {...props}>
        <option value="">{placeholder}</option>
        {options.map((o) => {
          const [value, text] = Array.isArray(o) ? o : [o, o]
          return (
            <option key={value} value={value}>
              {text}
            </option>
          )
        })}
      </select>
    </Field>
  )
}
export function Panel({ title, icon, action, className = '', children }) {
  return (
    <section className={'card epi-panel' + (className ? ' ' + className : '')}>
      <header>
        <h2 className={icon ? 'epi-panel-title-icon' : undefined}>
          {icon}
          <span>{title}</span>
        </h2>
        {action}
      </header>
      {children}
    </section>
  )
}
export function Table({ headers, rows, empty = 'Nenhum registro disponível.' }) {
  if (!rows.length) return <p className="epi-empty">{empty}</p>
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            {headers.map((h) => (
              <th key={h}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((cell, j) => (
                <td key={j}>{cell ?? '—'}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
export function ActionForm({ children, submit, onSave, onDone, disabled = false }) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  const lock = useRef(false),
    key = useRef(null)
  async function save(e) {
    e.preventDefault()
    if (lock.current) return
    const form = e.currentTarget
    lock.current = true
    setBusy(true)
    setError('')
    key.current ??= crypto.randomUUID()
    try {
      await onSave({ ...Object.fromEntries(new FormData(form)), id: key.current })
      key.current = null
      form.reset()
      onDone?.()
    } catch (err) {
      setError(err.message || 'Falha ao salvar. Tente novamente.')
    } finally {
      lock.current = false
      setBusy(false)
    }
  }
  return (
    <form className="epi-form" onSubmit={save}>
      <fieldset disabled={busy || disabled}>
        {children}
        <div className="epi-form-end">
          <button className="primary" aria-busy={busy} disabled={busy || disabled}>
            {busy ? 'Salvando…' : submit}
          </button>
        </div>
      </fieldset>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </form>
  )
}
export async function rpc(db, name, params) {
  const { data, error } = await db.rpc('ssma_epi_' + name, params)
  if (error) {
    const messages = {
      23505: 'Este cadastro já existe. Confira os dados.',
      23514: 'Confira os valores e os campos obrigatórios.',
      42501: 'Você não possui permissão para esta operação.',
    }
    throw new Error(messages[error.code] || error.message)
  }
  return data
}
