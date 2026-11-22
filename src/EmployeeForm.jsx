import React, { useEffect, useState } from 'react'
import { regionOf } from './epiData'
import { today } from './data'

const certificates = [
  ['nr06', 'NR 06'],
  ['nr10', 'NR 10 Básica'],
  ['sep', 'SEP'],
  ['nr12', 'NR 12'],
  ['nr18', 'NR 18'],
  ['nr20', 'NR 20'],
]
const contactFields = [
  ['registration', 'Matrícula'],
  ['cpf', 'CPF'],
  ['email', 'E-mail'],
  ['company', 'Empresa'],
  ['cnpj', 'CNPJ'],
  ['sector', 'Setor'],
  ['coordinator', 'Coordenador'],
  ['management', 'Gerência'],
]
function formatCpf(value) {
  return value
    .replace(/\D/g, '')
    .slice(0, 11)
    .replace(/^(\d{3})(\d)/, '$1.$2')
    .replace(/\.(\d{3})(\d)/, '.$1.$2')
    .replace(/\.(\d{3})(\d)/, '.$1-$2')
}

export function employeePayload(form, record, owner, profile) {
  const value = (key) => String(form.get(key) ?? '').trim()
  const details = {
    ...record.details,
    admission: value('admission'),
    technicianId: profile?.is_master ? value('technicianId') || null : (record.id ? record.details?.technicianId || null : owner),
    extra: value('extra'),
    region: regionOf(value('employee_state')),
  }
  for (const [key] of contactFields) details[key] = value(key)
  details.certifications = { ...record.details?.certifications }
  for (const [key] of certificates) {
    details.certifications[key] = {
      ...details.certifications[key],
      status: value(key + '_status'),
      date: value(key + '_date'),
      notes: value(key + '_notes'),
    }
  }
  return {
    module: 'colaboradores',
    owner_id: owner,
    title: value('title'),
    unit: value('unit'),
    person: profile?.is_master ? value('person') : (record.id ? record.person : profile.display_name),
    employee_state: value('employee_state') || null,
    status: form.has('dismissed')
      ? 'Inativo'
      : record.status && record.status !== 'Inativo'
        ? record.status
        : 'Ativo',
    event_date: record.event_date || today(),
    details,
  }
}

function TechnicianSelect({ db, record }) {
  const [people, setPeople] = useState([])
  const [state, setState] = useState('loading')
  const [attempt, setAttempt] = useState(0)
  const [choice, setChoice] = useState(null)
  useEffect(() => {
    let current = true
    async function loadDirectory() {
      setState('loading')
      try {
        const { data, error } = await db.rpc('ssma_employee_technicians')
        if (error || !Array.isArray(data)) throw Error()
        if (current) { setPeople(data); setState('ready') }
      } catch {
        if (current) setState('error')
      }
    }
    loadDirectory()
    return () => { current = false }
  }, [db, attempt])

  const previousId = record.details?.technicianId || ''
  const matches = people.filter(person => previousId ? person.id === previousId : person.name === record.person)
  const historical = Boolean(record.person || previousId) && matches.length !== 1
  const selected = choice ?? (historical ? 'previous' : matches[0]?.id || '')
  const technician = people.find(person => person.id === selected)
  const name = selected === 'previous' ? record.person : technician?.name
  const id = selected === 'previous' ? previousId : technician?.id
  return (
    <div>
      <label>Técnico de segurança responsável
        <select aria-label="Técnico de segurança responsável" value={selected} disabled={state !== 'ready'}
          onChange={event => setChoice(event.target.value)}>
          <option value="">{state === 'loading' ? 'Carregando técnicos…' : 'Sem responsável'}</option>
          {historical && <option value="previous">{record.person || 'Responsável anterior'} · cadastro anterior</option>}
          {people.map(person => <option key={person.id} value={person.id}>{person.name}</option>)}
        </select>
      </label>
      <input type="hidden" name="person" value={name || ''} />
      <input type="hidden" name="technicianId" value={id || ''} />
      {state === 'ready' && !people.length && <small>Nenhum técnico ativo cadastrado.</small>}
      {state === 'error' && <small role="alert">Falha ao carregar os técnicos. <button type="button" className="text-button" onClick={() => setAttempt(attempt + 1)}>Tentar novamente</button></small>}
    </div>
  )
}

export function EmployeeFields({ record, coverage, db, isMaster }) {
  const details = record.details || {}
  const [uf, setUf] = useState(record.employee_state || '')
  const [cpf, setCpf] = useState(formatCpf(details.cpf || ''))
  return (
    <div className="employee-form">
      <h3>Dados do colaborador</h3>
      <div className="form-grid">
        <label className="full">
          Colaborador
          <input name="title" defaultValue={record.title} maxLength={200} required />
        </label>
        <div className="full admission-row">
          <label>
            Data de admissão
            <input type="date" name="admission" defaultValue={details.admission} />
          </label>
          <label className="dismissed">
            <input type="checkbox" name="dismissed" defaultChecked={record.status === 'Inativo'} />
            Desligado
          </label>
        </div>
        <label>
          Cargo
          <input name="extra" defaultValue={details.extra} maxLength={250} />
        </label>
        {contactFields.filter(([key]) => key !== 'sector' || record.id).map(([key, label]) => (
          <label key={key}>
            {label}
            {key === 'cpf' ? (
              <input
                name="cpf"
                inputMode="numeric"
                placeholder="000.000.000-00"
                pattern="[0-9]{3}\.[0-9]{3}\.[0-9]{3}-[0-9]{2}"
                value={cpf}
                onChange={(e) => setCpf(formatCpf(e.target.value))}
              />
            ) : (
              <input
                type={key === 'email' ? 'email' : 'text'}
                name={key}
                defaultValue={details[key]}
                maxLength={254}
              />
            )}
          </label>
        ))}
        <label>
          UF
          <select
            aria-label="UF"
            name="employee_state"
            value={uf}
            required={!record.id}
            onChange={(e) => setUf(e.target.value)}
          >
            <option value="">Selecione a UF</option>
            {coverage.map((state) => (
              <option key={state}>{state}</option>
            ))}
          </select>
        </label>
        <label>
          Região
          <input readOnly value={regionOf(uf)} placeholder="Selecione a UF" />
        </label>
        {isMaster && <TechnicianSelect db={db} record={record} />}
        <label>
          Projeto
          <input name="unit" defaultValue={record.unit} maxLength={120} required />
        </label>
      </div>
      <h3>Certificações</h3>
      {certificates.map(([key, label]) => {
        const cert = details.certifications?.[key] || {}
        return (
          <fieldset key={key}>
            <legend>{label}</legend>
            <div className="form-grid">
              <label>
                Status · {label}
                <select
                  aria-label={'Status · ' + label}
                  name={key + '_status'}
                  defaultValue={cert.status || ''}
                >
                  <option value="">Selecione</option>
                  {['Ativo', 'Inativo', 'Suspenso'].map((status) => (
                    <option key={status}>{status}</option>
                  ))}
                </select>
              </label>
              <label>
                Data da última certificação · {label}
                <input type="date" name={key + '_date'} defaultValue={cert.date} />
              </label>
              <label className="full">
                Observações · {label}
                <textarea name={key + '_notes'} rows={2} defaultValue={cert.notes} maxLength={10000} />
              </label>
            </div>
          </fieldset>
        )
      })}
    </div>
  )
}
