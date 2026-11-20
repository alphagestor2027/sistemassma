import React, { useEffect, useState } from 'react'
import { Users, Heart, TriangleAlert, HardHat, GraduationCap, FileCheck2 } from 'lucide-react'
import { modules, groups } from './config'
import { epiSections } from './access'
import { indicators, percent } from './data'
import { Select, Panel, Table } from './EpiShared'
import './epi.css'

const metrics = [
  ['Colaboradores ativos', Users],
  ['Exames a vencer', Heart],
  ['Acidentes no período', TriangleAlert],
  ['EPIs a entregar', HardHat],
  ['Treinamentos pendentes', GraduationCap],
  ['Licenças a vencer', FileCheck2],
]
const grants = [
  ...Object.values(modules)
    .filter((m) => m.id !== 'epis')
    .map((m) => [m.id, m.name]),
  ...Object.entries(epiSections).map(([name, key]) => ['epi.' + key, 'EPI · ' + name]),
]
function Permissions({ person, db, reload }) {
  const [chosen, setChosen] = useState(person.permissions),
    [busy, setBusy] = useState(false),
    [msg, setMsg] = useState('')
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault()
        setBusy(true)
        setMsg('')
        try {
          const { error } = await db.rpc('ssma_master', {
            action: 'permissions',
            p: { technician: person.id, previous: person.permissions, permissions: chosen },
          })
          if (error) throw error
          await reload()
          setMsg('Permissões salvas.')
        } catch (err) {
          setMsg(err.message)
        } finally {
          setBusy(false)
        }
      }}
    >
      <fieldset disabled={busy} style={{ border: 0, padding: 0 }}>
        <legend>Módulos disponíveis para {person.name}</legend>
        <div className="permission-grid">
          {grants.map(([key, label]) => (
            <label key={key}>
              <input
                type="checkbox"
                checked={chosen.includes(key)}
                onChange={(e) => {
                  setMsg('')
                  setChosen(e.target.checked ? [...chosen, key] : chosen.filter((k) => k !== key))
                }}
              />
              {label}
            </label>
          ))}
        </div>
        <button className="primary">Salvar permissões</button>
      </fieldset>
      {msg && <p role="status">{msg}</p>}
    </form>
  )
}
export default function Master({ db, days, Trend }) {
  const [data, setData] = useState(null),
    [tech, setTech] = useState(''),
    [uf, setUf] = useState(''),
    [edit, setEdit] = useState(''),
    [error, setError] = useState('')
  async function reload() {
    const { data, error } = await db.rpc('ssma_master', { action: 'overview', p: {} })
    if (error) {
      setError(error.message)
      return
    }
    setData(data)
    setError('')
  }
  useEffect(() => {
    reload()
  }, [db])
  if (error)
    return (
      <div role="alert" className="notice error">
        {error}
        <button onClick={reload}>Tentar novamente</button>
      </div>
    )
  if (!data) return <p className="notice">Carregando indicadores…</p>
  const people = data.people,
    projects = data.projects.filter((p) => !tech || p.tech === tech),
    selected = people.find((p) => p.id === edit)
  const rows = data.rows.filter((r) => (!tech || r.techs.includes(tech)) && (!uf || r.states.includes(uf)))
  const totals = indicators(rows, days)
  const percentage = (list) => {
    const value = percent(list)
    return value === null ? '—' : value + '%'
  }
  return (
    <div className="epi">
      <Panel
        title="Indicadores de SSMA"
        action={
          <button className="secondary" onClick={reload}>
            Atualizar
          </button>
        }
      >
        <div className="epi-filters">
          <Select
            label="Técnico de segurança"
            placeholder="Todos os responsáveis"
            options={people.map((p) => [p.id, p.name])}
            value={tech}
            onChange={(e) => {
              setTech(e.target.value)
              setUf('')
              setEdit(e.target.value)
            }}
          />
          <Select
            label="Estado"
            placeholder="Todos os estados"
            options={[...new Set(projects.map((p) => p.state))].sort()}
            value={uf}
            onChange={(e) => setUf(e.target.value)}
          />
        </div>
        <div className="kpi-grid">
          {metrics.map(([label, I], i) => (
            <div className="card kpi" key={label}>
              <span className="tile">
                <I size={20} />
              </span>
              <span>{label}</span>
              <strong>{totals[i]}</strong>
            </div>
          ))}
        </div>
      </Panel>
      <Panel title="Projetos por estado">
        <Table
          headers={['Estado', 'Projeto', 'Técnico responsável']}
          rows={projects
            .filter((p) => !uf || p.state === uf)
            .map((p) => [p.state, p.project, people.find((t) => t.id === p.tech)?.name])}
          empty="Nenhum projeto vinculado para esta seleção."
        />
      </Panel>
      <Panel title="Permissões por técnico">
        <Select
          label="Editar permissões de"
          placeholder="Selecione um técnico"
          options={people.filter((p) => !p.master).map((p) => [p.id, p.name])}
          value={selected?.master ? '' : edit}
          onChange={(e) => setEdit(e.target.value)}
        />
        {selected && !selected.master && (
          <Permissions key={selected.id} person={selected} db={db} reload={reload} />
        )}
        {!people.some((p) => !p.master) && (
          <p className="epi-help">Ainda não há perfis de técnicos cadastrados.</p>
        )}
      </Panel>
      <Panel title="Acidentes e incidentes">
        <p className="epi-help">Evolução mensal nos últimos 12 meses</p>
        <div className="chart-legend">
          <span>
            <i />
            Acidentes
          </span>
          <span>
            <i className="gray-dot" />
            Incidentes
          </span>
        </div>
        <Trend rows={rows} demo={false} />
      </Panel>
      <Panel title="Conformidade por área">
        <Table
          headers={['Área', 'Registros concluídos ou ativos']}
          rows={groups.map((g) => [
            g.name,
            percentage(rows.filter((r) => g.items.some(([id]) => id === r.module))),
          ])}
        />
      </Panel>
      <Panel title="Indicadores rápidos">
        <Table
          headers={['Indicador', 'Percentual']}
          rows={[
            ['Exames concluídos', 'exames'],
            ['EPIs entregues', 'epis'],
            ['Treinamentos concluídos', 'treinamentos'],
            ['Resíduos destinados', 'residuos'],
          ].map(([label, id]) => [label, percentage(rows.filter((r) => r.module === id))])}
        />
      </Panel>
    </div>
  )
}
