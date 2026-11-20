import React, { useState } from 'react'
import { CaResult, useCaLookup } from './CaCatalog'
import { Panel, ActionForm, Field, Select, Table } from './EpiShared'
import { available, variant, regionLabel, states, forecast, money } from './epiData'
import { dateLabel, today } from './data'

const numberProps = { type: 'number', min: 0, step: 1 }
export function Regions({ data, employees, profile, save }) {
  const [emp, setEmp] = useState('')
  const owned = data.regions.filter((r) => r.owner_id === profile.user_id)
  const active = employees.filter((e) => e.status === 'Ativo')
  const employee = active.find((e) => e.id === emp)
  return (
    <>
      <Panel title="Regionais e técnicos responsáveis">
        <ActionForm submit="Salvar regional" onSave={(p) => save('region', p)}>
          <Select label="Estado" name="state" options={states} required />
          <Field label="Nome da regional" name="name" required maxLength={150} />
          <Field label="Login do técnico no SSMA" name="login" defaultValue={profile.username} required />
        </ActionForm>
        <Table
          headers={['Estado', 'Regional', 'Técnico responsável', 'Login']}
          rows={data.regions.map((r) => [r.state, r.name, r.technician, r.technician_login])}
        />
      </Panel>
      <Panel title="Vínculos dos colaboradores">
        <ActionForm submit="Salvar vínculo" onSave={(p) => save('assignment', p)} onDone={() => setEmp('')}>
          <Select
            label="Colaborador"
            name="employee_id"
            options={active.map((e) => [e.id, e.title])}
            value={emp}
            onChange={(e) => setEmp(e.target.value)}
            required
          />
          <Select
            label="Regional do colaborador"
            name="region_id"
            options={owned.map((r) => [r.id, regionLabel(r)])}
            required
          />
          <Field
            key={'project' + emp}
            label="Nome do projeto / unidade"
            name="project"
            defaultValue={employee?.unit || ''}
            required
          />
          <Field
            key={'job' + emp}
            label="Cargo"
            name="job"
            defaultValue={employee?.details?.extra || ''}
            required
          />
          <Field label="Centro de custo" name="center" />
          <Field label="Contrato" name="contract" />
        </ActionForm>
        <Table
          headers={['Colaborador', 'Regional', 'Projeto', 'Cargo', 'Centro de custo', 'Contrato']}
          rows={data.assignments.map((a) => [
            a.employee || employees.find((e) => e.id === a.employee_id)?.title,
            regionLabel(data.regions.find((r) => r.id === a.region_id)),
            a.project,
            a.job,
            a.center || '—',
            a.contract || '—',
          ])}
        />
      </Panel>
    </>
  )
}

export function Stock({ db, data, profile, save }) {
  const [noCA, setNoCA] = useState(false),
    [region, setRegion] = useState(''),
    [search, setSearch] = useState(''),
    [show, setShow] = useState('')
  const owned = data.regions.filter((r) => r.owner_id === profile.user_id)
  const [ca, setCa] = useState(''),
    [name, setName] = useState(null),
    [ficha, setFicha] = useState(0)
  const stockCa = !show && /^\d{1,70}$/.test(search.trim()) ? search.trim() : ''
  const lookup = useCaLookup(db, show === 'lookup' || (show === 'new' && !noCA) ? ca : stockCa)
  const suggested = lookup?.records?.[ficha]?.equipamento || ''
  function changeCa(value) {
    setCa(value)
    setFicha(0)
  }
  function open(mode) {
    setShow(show === mode ? '' : mode)
    setNoCA(false)
    changeCa('')
    setName(null)
  }
  const regionalOptions = owned.map((r) => [r.id, regionLabel(r)])
  const materialOptions = data.materials.map((m) => [
    m.id,
    variant(m) +
      (m.stock_center ? ' · ' + m.stock_center : '') +
      ' · ' +
      regionLabel(data.regions.find((r) => r.id === m.region_id)),
  ])
  const [center, setCenter] = useState('')
  const materials = data.materials.filter(
    (m) =>
      (!region || (m.region_id || 'none') === region) &&
      (!center || (m.stock_center || '—') === center) &&
      [variant(m), m.ca].join(' ').toLowerCase().includes(search.toLowerCase()),
  )
  return (
    <>
      <Panel
        title="Estoque de materiais"
        action={
          <div className="button-group">
            <button className="secondary" onClick={() => open('lookup')}>
              Consultar CA
            </button>
            <button className="secondary" onClick={() => open('entry')}>
              Registrar entrada
            </button>
            <button className="primary" onClick={() => open('new')}>
              Cadastrar material
            </button>
          </div>
        }
      >
        {show === 'lookup' && (
          <div className="ca-search">
            <Field
              label="Número do CA"
              type="search"
              inputMode="numeric"
              maxLength={70}
              value={ca}
              onChange={(e) => changeCa(e.target.value)}
            />
            <CaResult result={lookup} index={ficha} onSelect={setFicha} onRegister={() => setShow('new')} />
          </div>
        )}
        {show === 'new' && (
          <ActionForm
            submit="Salvar material"
            onSave={(p) => save('material', { ...p, no_ca: noCA })}
            onDone={() => {
              setNoCA(false)
              setShow('')
            }}
          >
            <Field
              label="Nome do material"
              name="name"
              value={name ?? suggested.slice(0, 200)}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={200}
            />
            <Field
              label="CA"
              name="ca"
              value={noCA ? '' : ca}
              onChange={(e) => changeCa(e.target.value)}
              inputMode="numeric"
              required={!noCA}
              disabled={noCA}
              maxLength={70}
            />
            <label className="epi-check">
              <input type="checkbox" checked={noCA} onChange={(e) => setNoCA(e.target.checked)} />
              Material sem CA
            </label>
            {!noCA && <CaResult result={lookup} index={ficha} onSelect={setFicha} />}
            <Field label="Valor unitário (R$)" name="price" type="number" min="0" step="0.01" />
            <Field label="Quantidade" name="qty" {...numberProps} />
            <Field label="Validade" name="expiry" type="date" />
            <Field label="Quantidade mínima" name="minimum" {...numberProps} />
            <Field label="Tamanho / numeração" name="size" />
            <Select
              label="Cor"
              name="color"
              placeholder="Selecione a cor"
              options={[
                'Amarelo',
                'Azul',
                'Azul-marinho',
                'Bege',
                'Branco',
                'Cinza',
                'Incolor',
                'Laranja',
                'Marrom',
                'Multicolorido',
                'Preto',
                'Rosa',
                'Roxo',
                'Verde',
                'Vermelho',
                'Vinho',
                'Outra',
              ]}
            />
            <Field
              label="Centro de custo do estoque"
              name="stock_center"
              list="stock-centers"
              placeholder="Compartilhado na regional"
            />
            <datalist id="stock-centers">
              {[...new Set(data.assignments.map((a) => a.center).filter(Boolean))].map((c) => (
                <option key={c}>{c}</option>
              ))}
            </datalist>
            <Select
              label="Estoque regional"
              name="region_id"
              options={regionalOptions}
              placeholder="Vincular depois"
            />
          </ActionForm>
        )}
        {show === 'entry' && (
          <ActionForm submit="Confirmar entrada" onSave={(p) => save('entry', p)} onDone={() => setShow('')}>
            <Select label="Material" name="material_id" options={materialOptions} required />
            <Field label="Quantidade recebida" name="qty" type="number" min={1} required />
            <Field
              label="Valor unitário da entrada (R$)"
              name="price"
              type="number"
              min="0"
              step="0.01"
              placeholder="Usar o custo atual"
            />
          </ActionForm>
        )}
        <div className="epi-filters">
          <Field
            label="Buscar material ou CA"
            type="search"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value)
              if (!show) setFicha(0)
            }}
          />
          <Select
            label="Filtrar estoque"
            value={region}
            onChange={(e) => setRegion(e.target.value)}
            placeholder="Todas as regionais"
            options={[['none', 'Sem regional'], ...data.regions.map((r) => [r.id, regionLabel(r)])]}
          />
          <Select
            label="Filtrar centro de custo"
            placeholder="Todos os centros"
            value={center}
            onChange={(e) => setCenter(e.target.value)}
            options={['—', ...new Set(data.materials.map((m) => m.stock_center).filter(Boolean))].map((c) => [
              c,
              c === '—' ? 'Estoque compartilhado' : c,
            ])}
          />
        </div>
        {stockCa && (
          <CaResult
            result={lookup}
            index={ficha}
            onSelect={setFicha}
            onRegister={() => {
              setCa(stockCa)
              setName(null)
              setNoCA(false)
              setShow('new')
            }}
          />
        )}
        <Table
          headers={[
            'Material / grade',
            'CA',
            'Regional',
            'Centro de custo',
            'Físico',
            'Reservado',
            'Disponível',
            'Mínimo',
            'Valor unitário',
            'Validade',
          ]}
          rows={materials.map((m) => [
            variant(m),
            m.no_ca ? <span className="badge red">Sem CA</span> : m.ca,
            regionLabel(data.regions.find((r) => r.id === m.region_id)),
            m.stock_center || 'Compartilhado',
            m.qty,
            m.reserved,
            available(m),
            <span className={available(m) < m.minimum ? 'badge red' : ''}>{m.minimum}</span>,
            money(m.price),
            <span className={m.expiry && m.expiry < today() ? 'red-text' : ''}>{dateLabel(m.expiry)}</span>,
          ])}
          empty="Nenhum material encontrado neste estoque."
        />
      </Panel>
      {data.materials.some((m) => !m.region_id) && (
        <Panel title="Vincular material a uma regional">
          <ActionForm submit="Vincular estoque" onSave={(p) => save('allocate', p)}>
            <Select
              label="Material sem regional"
              name="material_id"
              options={data.materials.filter((m) => !m.region_id).map((m) => [m.id, variant(m)])}
              required
            />
            <Select label="Regional de destino" name="region_id" options={regionalOptions} required />
          </ActionForm>
        </Panel>
      )}
    </>
  )
}

export function Planning({ data, save }) {
  const [horizon, setHorizon] = useState(30)
  return (
    <>
      <Panel title="Periodicidade de troca por cargo">
        <ActionForm submit="Salvar periodicidade" onSave={(p) => save('rule', p)}>
          <Select
            label="Material e regional"
            name="material_id"
            options={data.materials
              .filter((m) => m.region_id)
              .map((m) => [
                m.id,
                variant(m) +
                  (m.stock_center ? ' · ' + m.stock_center : '') +
                  ' · ' +
                  regionLabel(data.regions.find((r) => r.id === m.region_id)),
              ])}
            required
          />
          <Field label="Cargo" name="job" list="epi-jobs" required />
          <datalist id="epi-jobs">
            {[...new Set(data.assignments.map((a) => a.job))].map((j) => (
              <option key={j}>{j}</option>
            ))}
          </datalist>
          <Field label="Troca a cada (dias)" name="days" type="number" min={1} required />
          <Field label="Quantidade por troca" name="qty" type="number" min={1} defaultValue={1} required />
        </ActionForm>
        <Table
          headers={['Material', 'Regional', 'Cargo', 'Intervalo', 'Quantidade']}
          rows={data.rules.map((r) => {
            const m = data.materials.find((m) => m.id === r.material_id)
            return [
              variant(m),
              regionLabel(data.regions.find((v) => v.id === m.region_id)),
              r.job,
              r.days + ' dias',
              r.qty,
            ]
          })}
        />
      </Panel>
      <Panel
        title="Previsão de compras"
        action={
          <Select
            label="Horizonte"
            value={horizon}
            options={[30, 60, 90, 180].map((n) => [n, n + ' dias'])}
            onChange={(e) => setHorizon(Number(e.target.value))}
          />
        }
      >
        <p className="epi-help">
          A previsão considera colaboradores ativos por cargo e regional, última entrega, reservas e estoque
          mínimo. Sem entrega anterior, a primeira troca entra na previsão de hoje.
        </p>
        <Table
          headers={[
            'Material / grade',
            'Regional',
            'Centro de custo',
            'Disponível',
            'Mínimo',
            'Demanda prevista',
            'Comprar',
            'Custo estimado',
          ]}
          rows={data.materials.map((m) => {
            const f = forecast(m, data.rules, data.assignments, data.requests, horizon)
            return [
              variant(m),
              regionLabel(data.regions.find((r) => r.id === m.region_id)),
              m.stock_center || 'Compartilhado',
              available(m),
              m.minimum,
              f.demand,
              f.buy,
              money(f.buy * m.price),
            ]
          })}
        />
      </Panel>
    </>
  )
}
