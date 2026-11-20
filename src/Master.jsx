import React, { useEffect, useState } from 'react'
import { Users, Heart, TriangleAlert, HardHat, GraduationCap, FileCheck2 } from 'lucide-react'
import { modules, groups } from './config'
import { epiSections } from './access'
import { indicators, percent } from './data'
import { Select, Panel, Table, ActionForm, Field } from './EpiShared'
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
function areaSummary(areas, coverage = []) {
  return (
    Object.entries(areas)
      .filter(([, ufs]) => ufs.some((uf) => coverage.includes(uf)))
      .map(([name, ufs]) => {
        const selected = ufs.filter((uf) => coverage.includes(uf))
        return selected.length === ufs.length ? name + ' (toda a região)' : name + ' · ' + selected.join(', ')
      })
      .join(' / ') || 'Sem área definida'
  )
}
function ServiceAreaFields({ areas, person }) {
  const [selected, setSelected] = useState(person?.coverage || [])
  function change(ufs, add) {
    setSelected((current) =>
      add ? [...new Set([...current, ...ufs])].sort() : current.filter((v) => !ufs.includes(v)),
    )
  }
  return (
    <div className="service-coverage">
      <input type="hidden" name="coverage" value={JSON.stringify(selected)} />
      <strong>Área de atendimento</strong>
      <p className="epi-help">Marque regiões inteiras ou combine estados de regiões diferentes.</p>
      <div className="coverage-grid">
        {Object.entries(areas)
          .sort(([a], [b]) => a.localeCompare(b, 'pt-BR'))
          .map(([region, ufs]) => {
            const all = ufs.every((v) => selected.includes(v)),
              some = ufs.some((v) => selected.includes(v))
            return (
              <div key={region} role="group" aria-label={region}>
                <label className="coverage-region">
                  <input
                    type="checkbox"
                    checked={all}
                    ref={(el) => {
                      if (el) el.indeterminate = some && !all
                    }}
                    onChange={(e) => change(ufs, e.target.checked)}
                  />
                  {region}
                </label>
                <div className="coverage-states">
                  {ufs.map((uf) => (
                    <label key={uf}>
                      <input
                        type="checkbox"
                        checked={selected.includes(uf)}
                        onChange={(e) => change([uf], e.target.checked)}
                      />
                      {uf}
                    </label>
                  ))}
                </div>
              </div>
            )
          })}
      </div>
    </div>
  )
}

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
export default function Master({ db, days, Trend, managing, navigate }) {
  const [data, setData] = useState(null),
    [tech, setTech] = useState(''),
    [uf, setUf] = useState(''),
    [edit, setEdit] = useState(''),
    [creating, setCreating] = useState(false),
    [notice, setNotice] = useState(''),
    [changingAccess, setChangingAccess] = useState(false),
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
  async function changeAccess(person, action) {
    if (changingAccess) return
    if (
      action === 'remove_technician' &&
      !window.confirm(
        'Remover ' +
          person.name +
          ' (' +
          person.username +
          ') da gestão de técnicos? O acesso será encerrado e o histórico de trabalho será preservado.',
      )
    )
      return
    setChangingAccess(true)
    setNotice('')
    try {
      const { data: result, error } = await db.rpc('ssma_master', {
        action,
        p: { technician: person.id, previous_active: person.active },
      })
      if (error) throw error
      if (action === 'remove_technician') {
        if (edit === person.id) setEdit('')
        if (tech === person.id) {
          setTech('')
          setUf('')
        }
      }
      await reload()
      const message = {
        block_technician: 'Acesso bloqueado',
        unblock_technician: 'Acesso desbloqueado',
        remove_technician: 'Técnico removido',
      }
      const regionalNotice = result?.region_count
        ? '. Atualize o responsável em EPI › Regionais e vínculos (' +
          result.region_count +
          ' com este responsável).'
        : ''
      setNotice(message[action] + ' · ' + person.name + regionalNotice)
    } catch (err) {
      setError(err.message || 'Não foi possível atualizar o acesso.')
    } finally {
      setChangingAccess(false)
    }
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
  const responsible = people.find((p) => p.id === tech)
  const rows = data.rows.filter((r) => (!tech || r.techs.includes(tech)) && (!uf || r.states.includes(uf)))
  const totals = indicators(rows, days)
  const percentage = (list) => {
    const value = percent(list)
    return value === null ? '—' : value + '%'
  }
  return (
    <div className="epi">
      <nav className="button-group" aria-label="Administração Master">
        <button className={managing ? 'secondary' : 'primary'} onClick={() => navigate('master')}>
          Visão geral
        </button>
        <button className={managing ? 'primary' : 'secondary'} onClick={() => navigate('technicians')}>
          <Users size={16} />
          Gestão de técnicos
        </button>
      </nav>
      {managing ? (
        <>
          <Panel
            title="Técnicos de segurança"
            action={
              <button
                className="primary"
                onClick={() => {
                  setCreating(true)
                  setEdit('')
                  setNotice('')
                }}
              >
                Cadastrar técnico
              </button>
            }
          >
            {notice && (
              <p className="epi-success" role="status">
                {notice}
              </p>
            )}
            {creating && (
              <>
                <ActionForm
                  submit="Criar conta do técnico"
                  onSave={async ({ name, username, password, coverage }) => {
                    const { data, error } = await db.functions.invoke('ssma-create-technician', {
                      body: { name, username, password, coverage: JSON.parse(coverage) },
                    })
                    if (error) {
                      const details = await error.context?.json?.().catch(() => null)
                      throw Error(
                        details?.message || 'Não foi possível cadastrar. Atualize a lista e tente novamente.',
                      )
                    }
                    await reload()
                    setEdit(data.id)
                    setCreating(false)
                    setNotice('Técnico cadastrado. Selecione os módulos que ele poderá acessar.')
                  }}
                >
                  <Field label="Nome completo" name="name" maxLength={120} required />
                  <Field
                    label="Usuário de acesso"
                    name="username"
                    required
                    minLength={3}
                    maxLength={40}
                    pattern="[a-z0-9][a-z0-9._\\-]{2,39}"
                    placeholder="Ex.: maria.silva"
                  />
                  <Field
                    label="Senha inicial"
                    name="password"
                    type="password"
                    autoComplete="new-password"
                    required
                    minLength={8}
                    maxLength={72}
                  />
                  <ServiceAreaFields areas={data.service_areas} />
                </ActionForm>
                <button className="text-button" onClick={() => setCreating(false)}>
                  Cancelar cadastro
                </button>
              </>
            )}
            <Table
              headers={['Nome', 'Usuário', 'Área de atendimento', 'Acesso', 'Ações']}
              rows={people
                .filter((p) => !p.master)
                .map((p) => [
                  p.name,
                  p.username,
                  areaSummary(data.service_areas, p.coverage),
                  p.active ? 'Ativo' : 'Bloqueado',
                  <div className="technician-actions">
                    <button
                      className="secondary"
                      onClick={() => {
                        setEdit(p.id)
                        setCreating(false)
                        setNotice('')
                      }}
                    >
                      Gerenciar {p.name}
                    </button>
                    <button
                      className="secondary"
                      disabled={changingAccess}
                      onClick={() => changeAccess(p, p.active ? 'block_technician' : 'unblock_technician')}
                    >
                      {p.active ? 'Bloquear' : 'Desbloquear'}
                    </button>
                    <button
                      className="secondary remove-technician"
                      disabled={changingAccess}
                      onClick={() => changeAccess(p, 'remove_technician')}
                    >
                      Remover
                    </button>
                  </div>,
                ])}
              empty="Nenhum técnico cadastrado. Use Cadastrar técnico para criar a primeira conta."
            />
          </Panel>
          {selected && !selected.master && (
            <>
              <Panel title={'Cadastro de ' + selected.name}>
                <ActionForm
                  key={JSON.stringify([selected.id, selected.name, selected.active, selected.coverage])}
                  submit="Salvar cadastro"
                  onSave={async (p) => {
                    const { error } = await db.rpc('ssma_master', {
                      action: 'edit_technician',
                      p: {
                        technician: selected.id,
                        name: p.name,
                        active: p.status === 'Ativo',
                        coverage: JSON.parse(p.coverage),
                        previous_coverage: selected.coverage,
                        previous_name: selected.name,
                        previous_active: selected.active,
                      },
                    })
                    if (error) throw error
                    await reload()
                    setNotice('Cadastro atualizado.')
                  }}
                >
                  <Field
                    label="Nome do técnico"
                    name="name"
                    required
                    maxLength={120}
                    defaultValue={selected.name}
                  />
                  <Select
                    label="Acesso ao sistema"
                    name="status"
                    required
                    options={['Ativo', 'Inativo']}
                    defaultValue={selected.active ? 'Ativo' : 'Inativo'}
                  />
                  <ServiceAreaFields areas={data.service_areas} person={selected} />
                </ActionForm>
              </Panel>
              <Panel title="Permissões por técnico">
                <Permissions key={selected.id} person={selected} db={db} reload={reload} />
              </Panel>
            </>
          )}
        </>
      ) : (
        <>
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
            {responsible && (
              <p className="epi-help">
                Área de atendimento: {areaSummary(data.service_areas, responsible.coverage)}
              </p>
            )}
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
        </>
      )}
    </div>
  )
}
