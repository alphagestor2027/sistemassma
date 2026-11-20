import { GloveIndicators } from './EpiIndicators'
import React, { useState } from 'react'
import { CaExpiryEditor, CaResult, useCaLookup } from './CaCatalog'
import { Panel, ActionForm, Field, Select, Table } from './EpiShared'
import { available, variant, regionLabel, forecast, money, after365 } from './epiData'
import { dateLabel, today } from './data'

function PriceField({ label, placeholder, initialValue }) {
  const [value, setValue] = useState(() => initialValue == null ? '' : Number(initialValue).toLocaleString('pt-BR', {minimumFractionDigits:2, maximumFractionDigits:2}))
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
const materialColors = ['Amarelo', 'Azul', 'Azul-marinho', 'Bege', 'Branco', 'Cinza', 'Incolor', 'Laranja', 'Marrom', 'Multicolorido', 'Preto', 'Rosa', 'Roxo', 'Verde', 'Vermelho', 'Vinho', 'Outra',]
const numberProps = { type: 'number', min: 0, step: 1 }
export function Regions({ data, employees, profile, save }) {
  const [emp, setEmp] = useState('')
  const units = data.regions.filter(r => r.distribution_unit)
  const options = units.map(r => [r.id, r.distribution_unit])
  const projects = data.projects || []
  const active = employees.filter(e => e.status === 'Ativo' && data.assignments.some(a => a.employee_id === e.id))
  const assignment = data.assignments.find(a => a.employee_id === emp)
  return (
    <>
      <Panel title="Unidades de distribuição">
        <Table headers={['Unidade', 'Responsável']} rows={units.map(r => [r.distribution_unit, r.technician])} />
        {profile.is_master && <ActionForm submit="Salvar responsável" onSave={p => save('region', p)}>
          <Select label="Unidade de distribuição" name="region_id" options={options} required />
          <Field label="Login do responsável no SSMA" name="login" required />
        </ActionForm>}
      </Panel>
      {profile.is_master && <Panel title="Unidade de distribuição por projeto">
        <ActionForm submit="Salvar unidade do projeto" onSave={p => save('project_unit', p)}>
          <Select label="Projeto" name="project" options={projects.map(p => p.project)} required />
          <Select label="Unidade que atende o projeto" name="region_id" options={options} required />
        </ActionForm>
        <Table headers={['Projeto', 'Unidade de distribuição']} rows={projects.map(p =>
          [p.project, units.find(r => r.id === p.region_id)?.distribution_unit || 'A definir'])}
          empty="Cadastre um colaborador com projeto para definir a unidade de distribuição." />
      </Panel>}
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
          <input type="hidden" name="region_id" value={assignment?.region_id || ''} />
          <Field label="Projeto" value={assignment?.project || ''} readOnly />
          <Field label="Unidade de distribuição" value={regionLabel(data.regions.find(r => r.id === assignment?.region_id))} readOnly />
          <Field key={'center'+emp} label="Centro de custo" name="center" defaultValue={assignment?.center || ''} />
          <Field key={'contract'+emp} label="Contrato" name="contract" defaultValue={assignment?.contract || ''} />
        </ActionForm>
        <Table
          headers={['Colaborador', 'Unidade', 'Projeto', 'Cargo', 'Centro de custo', 'Contrato']}
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
  const [selected, setSelected] = useState(null)
  const editing = show === 'edit' ? selected : null
  const formHeading = React.useRef(null)
  React.useEffect(() => {
    if (show === 'edit' || show === 'delete') formHeading.current?.focus()
  }, [show, selected])
  function selectMaterial(material, mode) {
    setSelected(material)
    setShow(mode)
    setName(material.name)
    setCa(material.ca)
    setNoCA(material.no_ca)
    setFicha(0)
    setStart(material.glove_start || '')
    setManualGlove(material.insulating_glove)
  }
  const stockCa = !show && /^\d{1,70}$/.test(search.trim()) ? search.trim() : ''
  const lookup = useCaLookup(db, show === 'lookup' || ((show === 'new' || editing) && !noCA) ? ca : stockCa)
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
  const regionalOptions = data.regions.filter(r => r.distribution_unit).map(r => [r.id, r.distribution_unit])
  const [start, setStart] = useState(''),
    [manualGlove, setManualGlove] = useState(false)
  const detected = /luva.*isolante/i.test(name || '') || /luva.*isolante/i.test(suggested)
  const glove = detected || manualGlove
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
        {(editing || show === 'delete') && (
          <h3 ref={formHeading} tabIndex={-1}>{editing ? 'Editar material' : 'Excluir material'} · {variant(selected)}</h3>
        )}
        {show === 'delete' && selected.reserved > 0 && <div className="notice" role="status">
          <p>Este material tem reservas. Conclua ou cancele os pedidos antes de excluí-lo.</p>
          <button type="button" className="secondary" onClick={() => setShow('')}>Fechar</button>
        </div>}
        {show === 'delete' && !selected.reserved && <ActionForm key={selected.id} submit="Confirmar exclusão"
          onSave={() => save('delete_material',{material_id:selected.id, revision:selected.revision})} onDone={() => setShow('')}
          >
          <p>O material será retirado do estoque. O histórico de movimentações e entregas será preservado.</p>
          {selected.qty > 0 && <p>Baixa de {selected.qty} unidade(s) no estoque.</p>}
          <button type="button" className="secondary" onClick={() => setShow('')}>Cancelar</button>
        </ActionForm>}
        {(show === 'new' || editing) && (
          <ActionForm key={editing?.id || 'new'}
            submit={editing ? 'Salvar alterações' : 'Salvar material'}
            onSave={(p) =>
              save(editing ? 'edit_material' : 'material', {
                ...p,
                ...(editing && {material_id:editing.id, revision:editing.revision, qty:p.qty || 0, minimum:p.minimum || 0, price:p.price || 0}),
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
            <PriceField label="Valor unitário (R$)" initialValue={editing?.price} />
            <Field label="Quantidade" name="qty" {...numberProps} min={editing?.reserved || 0} defaultValue={editing?.qty} />
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
                <Field label="Vencimento do material em estoque" name="expiry" type="date" defaultValue={editing?.expiry} />
              </details>
            )}
            <Field label="Quantidade mínima" name="minimum" {...numberProps} defaultValue={editing?.minimum} />
            <Field label="Tamanho / numeração" name="size" defaultValue={editing?.size} />
            <Select
              label="Cor"
              name="color"
              defaultValue={editing?.color}
              placeholder="Selecione a cor"
              options={[
                ...materialColors,
                ...(editing?.color && !materialColors.includes(editing.color) ? [editing.color] : []),
              ]}
            />
            <Select
              label="Unidade de distribuição"
              name="region_id"
              options={regionalOptions}
              placeholder="Selecione a unidade"
              defaultValue={editing?.region_id}
              required
            />
            {editing && <button className="secondary" type="button" onClick={() => setShow('')}>Cancelar edição</button>}
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
            placeholder="Todas as unidades"
            options={[['none', 'Sem unidade'], ...data.regions.map((r) => [r.id, regionLabel(r)])]}
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
            'Unidade de distribuição',

            'Físico',
            'Reservado',
            'Disponível',
            'Mínimo',
            'Reposição',
            'Valor unitário',
            'Validade',
            'Ações',
          ]}
          rows={materials.map((m) => [
            variant(m),
            m.no_ca ? <span className="badge red">Sem CA</span> : m.ca,
            !m.region_id && (profile.is_master || m.owner_id === profile.user_id) ? (
              <ActionForm
                submit="Definir unidade"
                onSave={(p) => save('allocate', { ...p, material_id: m.id })}
              >
                <Select label="Unidade do material" name="region_id" options={regionalOptions} required />
              </ActionForm>
            ) : (
              regionLabel(data.regions.find((r) => r.id === m.region_id))
            ),

            m.qty,
            m.reserved,
            available(m),
            m.minimum,
            <span className={'badge ' + (available(m) < m.minimum ? 'red' : 'green')}>{available(m) < m.minimum ? 'Comprar' : 'Ideal'}</span>,
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
            <div className="button-group">
              <button className="secondary" aria-label={'Editar ' + variant(m)} onClick={() => selectMaterial(m,'edit')}>Editar</button>
              <button className="secondary" aria-label={'Excluir ' + variant(m)} onClick={() => selectMaterial(m,'delete')}>Excluir</button>
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
