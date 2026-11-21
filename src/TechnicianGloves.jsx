import React, { useEffect, useState } from 'react'
import { Skeleton } from './Skeleton'
import { Table } from './EpiShared'
import { dateLabel, today } from './data'
import { regionOf } from './epiData'

function replacementStatus(row, day) {
  if (row.rejected) return ['red', 'Reprovada · substituir']
  if (!row.due) return ['gray', 'Conferir certificado']
  const days = (Date.parse(row.due) - Date.parse(day)) / 86400000
  if (days < 0) return ['red', 'Vencida · substituir']
  if (days === 0) return ['red', 'Vence hoje · substituir']
  if (days <= 30) return ['red', 'Programar troca em até ' + days + (days === 1 ? ' dia' : ' dias')]
  return ['gray', 'Em dia']
}

export function TechnicianGloves({ db, profile }) {
  const [rows, setRows] = useState(null)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let active = true
    setRows(null)
    setFailed(false)
    async function load() {
      try {
        const { data, error } = await db.rpc('ssma_epi_technician_gloves')
        if (error || !Array.isArray(data)) throw Error()
        if (active) setRows(data)
      } catch {
        if (active) setFailed(true)
      }
    }
    load()
    return () => { active = false }
  }, [db, profile, attempt])

  const regions = [...new Set((profile.coverage || []).map(regionOf).filter(Boolean))]
  const day = today()
  return (
    <section className="card technician-gloves">
      <div className="card-heading">
        <div>
          <h2>Luvas isolantes entregues</h2>
          <p>{regions.length ? 'Área de atendimento · ' + regions.join(', ') : 'Área de atendimento sem região cadastrada'}</p>
        </div>
      </div>
      {failed ? <p role="alert">Falha ao carregar as luvas. <button type="button" className="text-button" onClick={() => setAttempt(n => n + 1)}>Tentar novamente</button></p>
        : rows === null ? <Skeleton layout="compact" label="Carregando luvas entregues…"/>
        : <Table headers={['Colaborador', 'Região / UF', 'Material', 'Quantidade', 'Validade', 'Troca']}
            empty="Nenhuma entrega de luvas isolantes para colaboradores ativos na sua área."
            rows={rows.map(row => {
              const [color, message] = replacementStatus(row, day)
              return [row.employee, [regionOf(row.state), row.state].filter(Boolean).join(' · '), row.material,
                row.qty, row.due ? dateLabel(row.due) : 'Sem data', <span className={'badge ' + color}>{message}</span>]
            })}/>}
    </section>
  )
}
