import React, { useEffect, useState } from 'react'
import { Field } from './EpiShared'

export function useCaLookup(db, input) {
  const number = input.trim().replace(/^0+(?=\d)/, '')
  const [result, setResult] = useState(null)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!/^\d+$/.test(number)) return
    let current = true
    const controller = new AbortController()
    const timer = setTimeout(async () => {
      try {
        const { data, error } = await db
          .rpc('ssma_epi_lookup_ca', { numero: number })
          .abortSignal(controller.signal)
        if (error) throw error
        if (current) setResult({ number, records: data || [] })
      } catch {
        if (current) setResult({ number, error: true })
      }
    }, 250)
    return () => {
      current = false
      clearTimeout(timer)
      controller.abort()
    }
  }, [db, number, attempt])
  if (!number) return null
  if (!/^\d+$/.test(number)) return { invalid: true }
  if (result?.number !== number) return { loading: true }
  return {
    ...result,
    retry: () => {
      setResult(null)
      setAttempt((n) => n + 1)
    },
  }
}

const details = [
  ['Descrição', 'descricao'],
  ['Referência', 'referencia'],
  ['Cor informada', 'cor'],
  ['Origem', 'natureza'],
  ['Marcação do CA', 'marcacao'],
  ['Processo', 'processo'],
  ['Aprovado para', 'aprovado'],
  ['Restrições', 'restricao'],
  ['Observações', 'observacao'],
]

export function CaResult({ result, index, onSelect, onRegister }) {
  if (!result) return null
  let notice
  if (result.invalid) notice = 'Use apenas os números do CA para consultar a base.'
  else if (result.loading) notice = 'Consultando CA…'
  else if (result.error) notice = 'Não foi possível consultar a base de CA.'
  else if (!result.records.length) notice = 'CA ' + result.number + ' não encontrado na base importada.'
  if (notice)
    return (
      <div role="status" className="ca-result">
        {notice}{' '}
        {result.error && (
          <button className="text-button" type="button" onClick={result.retry}>
            Tentar novamente
          </button>
        )}
      </div>
    )
  const ficha = result.records[index] || result.records[0]
  return (
    <section className="ca-result" aria-label="Certificado de Aprovação">
      <h3>
        CA {result.number} · {ficha.equipamento}
      </h3>
      {result.records.length > 1 && (
        <Field label="Ficha do certificado">
          <select value={index} onChange={(e) => onSelect(Number(e.target.value))}>
            {result.records.map((item, i) => (
              <option key={i} value={i}>
                {i + 1} · {item.equipamento} · {item.referencia || item.fabricante} · {item.validade}
              </option>
            ))}
          </select>
        </Field>
      )}
      <dl>
        {[
          ['Fabricante', ficha.fabricante],
          ['CNPJ', ficha.cnpj],
          ['Situação na base', ficha.situacao],
          ['Validade do CA', ficha.validade],
        ].map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value || 'Não informado'}</dd>
          </div>
        ))}
      </dl>
      <details>
        <summary>Descrição, proteção e laudos</summary>
        <dl>
          {details
            .filter(([, key]) => ficha[key])
            .map(([label, key]) => (
              <div key={key}>
                <dt>{label}</dt>
                <dd>{ficha[key]}</dd>
              </div>
            ))}
        </dl>
        {ficha.laudos?.length > 0 && (
          <ul>
            {ficha.laudos.map((item, i) => (
              <li key={i}>
                {[item.laboratorio, item.cnpj, item.laudo, item.norma].filter(Boolean).join(' · ')}
              </li>
            ))}
          </ul>
        )}
      </details>
      {onRegister && (
        <button className="secondary" type="button" onClick={onRegister}>
          Usar no cadastro de material
        </button>
      )}
    </section>
  )
}
