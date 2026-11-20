import React, { useEffect, useState } from 'react'
import { Panel, Table } from './EpiShared'
import { money, after365 } from './epiData'
import { today, dateLabel } from './data'
export function GloveIndicators({ db, technician = '', region = '', uf = '', revision }) {
  const [rows, setRows] = useState([]),
    [err, setErr] = useState('')
  useEffect(() => {
    let active = true
    setRows([])
    setErr('')
    db.rpc('ssma_epi_glove_summary', { technician: technician || null }).then(({ data, error }) => {
      if (active) {
        setErr(error?.message || '')
        setRows(Array.isArray(data) ? data : [])
      }
    })
    return () => {
      active = false
    }
  }, [db, technician, revision])
  const groups = new Map()
  for (const item of rows.filter((r) => (!region || r.region === region) && (!uf || r.state === uf))) {
    const key = uf ? item.region + ' · ' + uf : item.region
    const g = groups.get(key) || [key, 0, 0, 0]
    g[1] += item.qty
    g[2] += item.available
    g[3] += Math.round(item.cost * 100)
    groups.set(key, g)
  }
  const totals = [...groups.values()].reduce(
    (sum, [, qty, available, cost]) => [sum[0] + qty, sum[1] + available, sum[2] + cost],
    [0, 0, 0],
  )
  return (
    <Panel title="Luvas isolantes em estoque por região">
      {!err && groups.size > 0 && (
        <p className="epi-help">
          Total de {totals[0]} luvas · {totals[1]} disponíveis · {money(totals[2] / 100)} em estoque.
        </p>
      )}
      {err ? (
        <p role="alert">{err}</p>
      ) : (
        <Table
          headers={['Região', 'Quantidade física', 'Disponíveis', 'Custo do estoque SSMA']}
          rows={[...groups.values()].map(([k, q, a, c]) => [k, q, a, money(c / 100)])}
          empty="Nenhuma regional para esta seleção."
        />
      )}
    </Panel>
  )
}
export function ReplacementAlert({ requests }) {
  const due = requests
    .filter((q) => q.status === 'Entregue' && q.closed_at)
    .flatMap((q) => {
      const day = new Date(q.closed_at).toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' })
      const deadline = after365(day)
      return deadline <= today() ? q.items.map((item) => ({ name: item.name, qty: item.qty, deadline })) : []
    })
  if (!due.length) return null
  return (
    <section className="notice" role="status">
      <div>
        <strong>Está na hora de realizar a substituição do material.</strong>
        <ul>
          {due.map((d, i) => (
            <li key={i}>
              {d.name} · {d.qty} un. · 365 dias em {dateLabel(d.deadline)}
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}
