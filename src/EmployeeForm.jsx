import React, { useState } from 'react'
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

export function employeePayload(form, record, owner) {
  const value = (key) => String(form.get(key) ?? '').trim()
  const details = {
    ...record.details,
    admission: value('admission'),
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
    person: value('person'),
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

export function EmployeeFields({ record, coverage }) {
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
        {contactFields.map(([key, label]) => (
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
        <label>
          Técnico de segurança responsável
          <input name="person" defaultValue={record.person} maxLength={200} />
        </label>
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
