import React, { useMemo, useState } from 'react'
import { Download, Plus, Pencil, Trash2 } from 'lucide-react'
import { dateLabel, downloadCsv } from './data'
import {EmployeeHistory} from './EmployeeHistory'
import { regionOf } from './epiData'

const fields = [
  ['project', 'Projeto', 'Todos os projetos'],
  ['coordinator', 'Coordenador', 'Todos os coordenadores'],
  ['region', 'Região', 'Todas as regiões'],
  ['state', 'Estado', 'Todos os estados'],
  ['manager', 'Gerente', 'Todas as gerências'],
]
const collator = new Intl.Collator('pt-BR', { sensitivity: 'base', numeric: true })

function normalize(value) {
  return String(value ?? '').trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
}

function employeeState(row) {
  return row.employee_state || row.unit?.trim().toUpperCase().match(/\/\s*([A-Z]{2})$/)?.[1] || ''
}

function employeeEntry(row) {
  const details = row.details || {}
  const state = employeeState(row)
  const labels = {
    project: row.unit,
    coordinator: details.coordinator,
    manager: details.management,
    state,
    region: regionOf(state) || details.region,
  }
  const values = Object.fromEntries(fields.map(([key]) => [key, normalize(labels[key])]))
  const searchText = normalize([row.title, row.person, row.notes, details.extra, ...Object.values(labels)].join(' '))
  return { row, labels, values, searchText }
}

export function EmployeeList({ canViewSheets, db, rows, search, add, edit, remove }) {
  const [selected,setSelected]=useState(null)
  const employee=rows.find(r=>r.id===selected)
  const [selection, setSelection] = useState({})
  const [status, setStatus] = useState('')
  const [order, setOrder] = useState('asc')
  const entries = useMemo(() => rows.map(employeeEntry), [rows])
  const query = normalize(search)
  const found = entries.filter(({ values, searchText }) =>
    searchText.includes(query) && fields.every(([key]) => !selection[key] || selection[key] === values[key])
  ).sort((a, b) => {
    const comparison = collator.compare(a.row.title, b.row.title)
    return (order === 'desc' ? -comparison : comparison) || collator.compare(a.row.id, b.row.id)
  }).map(({ row }) => row)

  function selectField(key, value) {
    setSelection(previous => key === 'region'
      ? { ...previous, region: value, state: '' }
      : { ...previous, [key]: value })
  }

  const controls = (
    <fieldset className="employee-filters">
      <legend>Filtros de colaboradores</legend>
      <div className="employee-filter-grid">
        <label>Ordem alfabética
          <select aria-label="Ordem alfabética" value={order} onChange={event => setOrder(event.target.value)}>
            <option value="asc">Nome de A a Z</option>
            <option value="desc">Nome de Z a A</option>
          </select>
        </label>
        {fields.map(([key, label, placeholder]) => {
          const options = new Map()
          for (const { labels, values } of entries) {
            if (key === 'state' && selection.region && selection.region !== values.region) continue
            if (values[key]) options.set(values[key], labels[key].trim())
          }
          return (
            <label key={key}>{label}
              <select aria-label={label} value={selection[key] || ''} onChange={event => selectField(key, event.target.value)}>
                <option value="">{placeholder}</option>
                {Array.from(options).sort((a, b) => collator.compare(a[1], b[1])).map(([value, name]) =>
                  <option key={value} value={value}>{name}</option>
                )}
              </select>
            </label>
          )
        })}
      </div>
      {(order !== 'asc' || Object.values(selection).some(Boolean)) &&
        <button className="text-button" onClick={() => { setSelection({}); setOrder('asc') }}>Limpar filtros da lista</button>}
    </fieldset>
  )
  const visible = found.filter(row => !status || row.status === status)
  const situation = row => row.status === 'Inativo' ? 'Desligado' : row.status
  const statuses = [...new Set(['Ativo', 'Inativo', ...rows.map(row => row.status).filter(Boolean)])]
  const heading = ['Colaborador', 'Cargo', 'Matrícula', 'Projeto', 'Região', 'UF', 'Técnico responsável', 'Admissão', 'Situação']
  function exportEmployees() {
    const lines = visible.map(row => [row.title, row.details?.extra, row.details?.registration, row.unit,
      regionOf(employeeState(row)) || row.details?.region, employeeState(row), row.person, dateLabel(row.details?.admission), situation(row)])
    downloadCsv([heading, ...lines], 'ssma-colaboradores.csv')
  }
  return <>
    {employee&&<EmployeeHistory canViewSheets={canViewSheets} key={employee.id} row={employee} db={db} close={()=>setSelected(null)}/>}
    <div className="module-summary">
      <div className="card"><span>Colaboradores cadastrados</span><strong>{rows.length}</strong></div>
      <div className="card"><span>Ativos</span><strong>{rows.filter(row => row.status === 'Ativo').length}</strong></div>
      <div className="card"><span>Desligados</span><strong>{rows.filter(row => row.status === 'Inativo').length}</strong></div>
    </div>
    <section className="card records employee-directory">
      <div className="records-toolbar">
        <div><h2>Lista de colaboradores</h2><p>{visible.length} {visible.length === 1 ? 'colaborador encontrado' : 'colaboradores encontrados'}</p></div>
        <div className="button-group">
          <label className="select-wrap"><select aria-label="Filtrar situação" value={status} onChange={event => setStatus(event.target.value)}>
            <option value="">Todas as situações</option>
            {statuses.map(value => <option key={value} value={value}>{situation({status:value})}</option>)}
          </select></label>
          <button className="secondary" onClick={exportEmployees} disabled={!visible.length}><Download size={16}/> Exportar</button>
          <button className="primary" onClick={add}><Plus size={17}/> Novo colaborador</button>
        </div>
      </div>
      {controls}
      {visible.length ? <div className="table-scroll"><table>
        <thead><tr>{['Colaborador', 'Projeto', 'Região / UF', 'Técnico responsável', 'Admissão', 'Situação', 'Ações'].map(label => <th key={label} scope="col">{label}</th>)}</tr></thead>
        <tbody>{visible.map(row => {
          const uf = employeeState(row)
          const region = regionOf(uf) || row.details?.region
          return <tr key={row.id}>
            <td><button type="button" className="text-button" onClick={()=>setSelected(row.id)} aria-label={'Ver prontuário de '+row.title}>{row.title}</button><small>{[row.details?.extra, row.details?.registration && 'Matrícula ' + row.details.registration].filter(Boolean).join(' · ')}</small></td>
            <td>{row.unit || '—'}</td>
            <td>{[region, uf].filter(Boolean).join(' / ') || '—'}</td>
            <td>{row.person || 'Sem responsável'}</td>
            <td>{dateLabel(row.details?.admission)}</td>
            <td><span className={'badge ' + (row.status === 'Ativo' ? 'green' : 'gray')}>{situation(row)}</span></td>
            <td><div className="table-actions">{row.readOnly ? 'Consulta' : <>
              <button className="icon-button" onClick={() => edit(row)} aria-label={'Editar ' + row.title}><Pencil size={16}/></button>
              <button className="icon-button" onClick={() => remove(row)} aria-label={'Excluir ' + row.title}><Trash2 size={16}/></button>
            </>}</div></td>
          </tr>
        })}</tbody>
      </table></div> : <div className="empty"><h3>{rows.length ? 'Nenhum resultado para esses filtros' : 'Nenhum colaborador cadastrado'}</h3></div>}
    </section>
  </>
}
