import { GloveIndicators } from './EpiIndicators'
import React, { useState } from 'react'
import { CaExpiryEditor, CaResult, useCaLookup } from './CaCatalog'
import { Panel, ActionForm, Field, Select, Table } from './EpiShared'
import { available, variant, regionLabel, states, forecast, money, stockAreas, after365 } from './epiData'
import { dateLabel, today } from './data'

function PriceField({ label, placeholder }) {
  const [value, setValue] = useState('')
  const plain = value.replaceAll('.', '').replace(',', '.')
  return (
    <>
      <Field
        label={label}
        placeholder={placeholder || 'R$ 0,00'}
        inputMode="decimal"
        value={value ? 'R$ ' + value : ''}
        onChange={(e) => {
          const raw = e.target.value.replace(/[^0-9,]/g, '')
          const [whole, ...parts] = raw.split(',')
          setValue(
            raw
              ? (Number(whole) || 0).toLocaleString('pt-BR') +
                  (parts.length ? ',' + parts.join('').slice(0, 2) : '')
              : '',
          )
        }}
        onBlur={() => {
          if (value)
            setValue(
              Number(plain).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
            )
        }}
      />
      <input type="hidden" name="price" value={plain} />
    </>
  )
}
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
  const [ca, setCa] = useState(''),
    [name, setName] = useState(null),
    [ficha, setFicha] = useState(0)
  const stockCa = !show && /^\d{1,70}$/.test(search.trim()) ? search.trim() : ''
  const lookup = useCaLookup(db, show === 'lookup' || (show === 'new' && !noCA) ? ca : stockCa)
  const sheet = lookup?.records?.[ficha]
  const suggested = sheet?.equipamento || ''
  function changeCa(value) {
    setStart('')
    setManualGlove(false)
    setCa(value)
    setFicha(0)
  }
  function open(mode) {
    setStart('')
    setManualGlove(false)
    setShow(show === mode ? '' : mode)
    setNoCA(false)
    changeCa('')
    setName(null)
  }
  const coverage = profile.is_master ? states : profile.coverage || []
  const regionalOptions = Object.entries(stockAreas).flatMap(([area, ufs]) =>
    ufs
      .split(' ')
      .filter((uf) => coverage.includes(uf))
      .flatMap((uf) => {
        const existing = data.regions.filter((r) => r.state === uf)
        return existing.length
          ? existing.map((r) => [r.id, area + ' · ' + regionLabel(r)])
          : [['uf:' + uf, area + ' · ' + uf]]
      }),
  )
  const [start, setStart] = useState(''),
    [manualGlove, setManualGlove] = useState(false)
  const detected = /luva.*isolante/i.test(name || '') || /luva.*isolante/i.test(suggested)
  const glove = detected || manualGlove
  function regionalPayload(p) {
    return p.region_id?.startsWith('uf:') ? { ...p, region_id: '', region_state: p.region_id.slice(3) } : p
  }
  const materialOptions = data.materials.map((m) => [
    m.id,
    variant(m) + ' · ' + regionLabel(data.regions.find((r) => r.id === m.region_id)),
  ])
  const materials = data.materials.filter(
    (m) =>
      (!region || (m.region_id || 'none') === region) &&
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
            {sheet && (
              <CaExpiryEditor
                key={[ca, sheet.sheet_key, sheet.validade_manual].join('/')}
                sheet={sheet}
                onSave={async (date) => {
                  await save('ca_expiry', {
                    ca,
                    sheet_key: sheet.sheet_key,
                    previous_ca_expiry: sheet.validade_manual,
                    ca_expiry: date,
                  })
                  lookup.retry()
                }}
              />
            )}
          </div>
        )}
        {show === 'new' && (
          <ActionForm
            submit="Salvar material"
            onSave={(p) =>
              save('material', {
                ...regionalPayload(p),
                insulating_glove: glove,
                glove_start: glove ? start : null,
                no_ca: noCA,
                ...(p.ca_expiry && { previous_ca_expiry: sheet?.validade_manual }),
              })
            }
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
            <PriceField label="Valor unitário (R$)" />
            <Field label="Quantidade" name="qty" {...numberProps} />
            {sheet && !noCA && (
              <CaExpiryEditor key={[ca, sheet.sheet_key, sheet.validade_manual].join('/')} sheet={sheet} />
            )}
            <label className="epi-check">
              <input
                type="checkbox"
                checked={glove}
                disabled={detected}
                onChange={(e) => setManualGlove(e.target.checked)}
              />
              Luva isolante
            </label>
            {glove ? (
              <>
                <Field
                  label="Data inicial do certificado ou ensaio elétrico"
                  type="date"
                  value={start}
                  required
                  onChange={(e) => setStart(e.target.value)}
                />
                {start && <p>Vencimento da luva: {dateLabel(after365(start))}</p>}
              </>
            ) : (
              <details className="material-lot-expiry">
                <summary>Validade do lote (opcional)</summary>
                <Field label="Vencimento do material em estoque" name="expiry" type="date" />
              </details>
            )}
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
            <Select
              label="Estoque regional"
              name="region_id"
              options={regionalOptions}
              placeholder="Selecione a regional"
            />
          </ActionForm>
        )}
        {show === 'entry' && (
          <ActionForm submit="Confirmar entrada" onSave={(p) => save('entry', p)} onDone={() => setShow('')}>
            <Select label="Material" name="material_id" options={materialOptions} required />
            <Field label="Quantidade recebida" name="qty" type="number" min={1} required />
            <PriceField label="Valor unitário da entrada (R$)" placeholder="Usar o custo atual" />
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
            !m.region_id && m.owner_id === profile.user_id ? (
              <ActionForm
                submit="Definir regional"
                onSave={(p) => save('allocate', regionalPayload({ ...p, material_id: m.id }))}
              >
                <Select label="Regional do material" name="region_id" options={regionalOptions} required />
              </ActionForm>
            ) : (
              regionLabel(data.regions.find((r) => r.id === m.region_id))
            ),

            m.qty,
            m.reserved,
            available(m),
            <span className={available(m) < m.minimum ? 'badge red' : ''}>{m.minimum}</span>,
            money(m.price),
            <div>
              {m.insulating_glove && (
                <details>
                  <summary>{m.glove_start ? 'Atualizar ensaio' : 'Informar início'}</summary>
                  <ActionForm
                    submit="Salvar data"
                    onSave={(p) => save('glove_date', { ...p, material_id: m.id, previous: m.glove_start })}
                  >
                    <Field label="Data do certificado ou ensaio" name="glove_start" type="date" required />
                  </ActionForm>
                </details>
              )}
              <span className={m.expiry && m.expiry < today() ? 'red-text' : ''}>{dateLabel(m.expiry)}</span>
            </div>,
          ])}
          empty="Nenhum material encontrado neste estoque."
        />
      </Panel>
      <GloveIndicators db={db} revision={data} />
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
                variant(m) + ' · ' + regionLabel(data.regions.find((r) => r.id === m.region_id)),
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
