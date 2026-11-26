import { CaResult, useCaLookup } from './CaCatalog'
import React, { useEffect, useMemo, useState } from 'react'
import {
  Truck,
  CirclePlus,
  Coins,
  Package,
  FileText,
  Pencil,
  Trash2,
  MapPin,
  Search,
  UserCheck,
  Building2,
  Briefcase,
} from 'lucide-react'
import { ActionForm, Field, Panel, Select, Table, rpc } from './EpiShared'
import { DateRange, within, totalsBy } from './EpiReports'
import { PriceField } from './PriceField'
import { money, regionOf, states, stockAreas, variant } from './epiData'
import { dateLabel, today } from './data'
import { recentPeriod } from './reportFilters'
import { Skeleton } from './Skeleton'
import { cleanCep, formatCep, lookupCepDetails, resolveCepLocation } from './cepRegion'

const RECIPIENT_TYPES = ['Colaborador', 'Fornecedor', 'Outros']
const PAGE_LIMIT_OPTIONS = [
  ['10', '10 por página'],
  ['15', '15 por página'],
  ['25', '25 por página'],
]

function inferRecipientType(row) {
  if (row?.recipient_type && RECIPIENT_TYPES.includes(row.recipient_type)) return row.recipient_type
  if (row?.employee_id) return 'Colaborador'
  return 'Outros'
}

function inferChargeProject(row) {
  if (typeof row?.charge_project === 'boolean') return row.charge_project
  return Boolean(row?.project && !['SSMA', 'Setor Facilities'].includes(row.project))
}

function InvoiceItem({ db, index, materials, onRemove, item = {} }) {
  const [ca, setCa] = useState(item.ca || ''),
    [noCa, setNoCa] = useState(Boolean(item.no_ca)),
    [id, setId] = useState(item.material_id || ''),
    [glove, setGlove] = useState(false)
  const [name, setName] = useState(null),
    [sheet, setSheet] = useState(0)
  const lookup = useCaLookup(db, noCa ? '' : ca)
  const matches = (m, value) =>
    value.trim() &&
    [m.ca, ...(m.generic_cas || [])].some(
      (v) => v && String(v).replace(/^0+/, '') === value.trim().replace(/^0+/, ''),
    )
  const opts = materials.filter((m) => (noCa ? !m.ca : matches(m, ca)))
  return (
    <div className="invoice-item">
      <h3>Item {index + 1}</h3>
      <div className="epi-filters">
        <Field
          label="CA"
          name={'ca' + index}
          value={ca}
          required={!noCa}
          disabled={noCa}
          pattern="[0-9]+"
          onChange={(e) => {
            const value = e.target.value
            setCa(value)
            setName(null)
            setSheet(0)
            const found = materials.filter((m) => matches(m, value))
            setId(found.length === 1 ? found[0].id : '')
          }}
        />
        <label>
          <input
            type="checkbox"
            name={'no_ca' + index}
            checked={noCa}
            onChange={(e) => {
              setNoCa(e.target.checked)
              setCa('')
              setId('')
            }}
          />{' '}
          Material sem CA
        </label>
        <Select
          label="Material e grade"
          name={'material_id' + index}
          placeholder="Cadastrar novo item"
          options={[
            ...opts.map((m) => [m.id, variant(m)]),
            ...(id === item.material_id && !opts.some((m) => m.id === id) ? [[id, variant(item)]] : []),
          ]}
          value={id}
          onChange={(e) => setId(e.target.value)}
        />
        {!noCa && <CaResult result={lookup} index={sheet} onSelect={setSheet} />}
        {!id && (
          <>
            <Field
              value={name ?? lookup?.records?.[sheet]?.equipamento ?? ''}
              onChange={(e) => setName(e.target.value)}
              label="Nome do material"
              name={'name' + index}
              required
              maxLength={180}
            />
            <Field label="Cor" name={'color' + index} maxLength={60} />
            <Field label="Tamanho" name={'size' + index} maxLength={60} />
            <label>
              <input
                type="checkbox"
                name={'glove' + index}
                checked={glove}
                onChange={(e) => setGlove(e.target.checked)}
              />{' '}
              Luva isolante
            </label>
            {glove && (
              <>
                <Field label="Número da luva esquerda" name={'glove_left_number' + index} maxLength={100} />
                <Field label="Número da luva direita" name={'glove_right_number' + index} maxLength={100} />
              </>
            )}
            {glove && <Field label="Início do certificado ou ensaio da luva" name={'glove_start' + index} type="date" required={glove} />}
          </>
        )}
        <Field label="Quantidade" type="number" step="1" min="1" name={'qty' + index} defaultValue={item.qty} required />
        <PriceField name={'price' + index} initialValue={item.price} label="Valor unitário" required />
      </div>
      {onRemove && (
        <button type="button" className="text-button" onClick={onRemove}>
          Remover item
        </button>
      )}
    </div>
  )
}

function InvoiceForm({ db, materials, save, unit, editing }) {
  const [keys, setKeys] = useState(() => (editing ? editing.items.map((_, i) => i) : [0])),
    [next, setNext] = useState(editing?.items.length || 1)
  return (
    <ActionForm
      submit={editing ? 'Salvar alterações da nota' : 'Registrar nota e dar entrada no estoque'}
      onSave={(p) => {
        const items = keys.map((_, i) =>
          Object.fromEntries(
            [
              'ca',
              'no_ca',
              'name',
              'material_id',
              'color',
              'size',
              'qty',
              'price',
              'glove',
              'glove_start',
              'glove_left_number',
              'glove_right_number',
            ].map((k) => [k, ['no_ca', 'glove'].includes(k) ? Boolean(p[k + i]) : p[k + i] || '']),
          ),
        )
        return save({ id: p.id, number: p.number, series: p.series, cnpj: p.cnpj, date: p.date, unit_id: unit, items })
      }}
    >
      <Field label="CNPJ do fornecedor" name="cnpj" defaultValue={editing?.cnpj} required maxLength={18} />
      <Field label="Número da nota fiscal" name="number" defaultValue={editing?.number} required maxLength={40} />
      <Field label="Série" name="series" defaultValue={editing?.series} maxLength={12} />
      <Field label="Data de emissão" type="date" name="date" required defaultValue={editing?.issued || today()} />
      <div className="invoice-lines">
        {keys.map((k, i) => (
          <InvoiceItem
            db={db}
            key={k}
            index={i}
            item={editing?.items[k]}
            materials={materials}
            onRemove={keys.length > 1 ? () => setKeys(keys.filter((x) => x !== k)) : undefined}
          />
        ))}
        <button
          type="button"
          className="secondary"
          disabled={keys.length >= 100}
          onClick={() => {
            setKeys([...keys, next])
            setNext(next + 1)
          }}
        >
          Adicionar item
        </button>
      </div>
    </ActionForm>
  )
}

function ShippingForm({ employees, projects = [], profile, unit, save, editing }) {
  const initialType = editing ? inferRecipientType(editing) : 'Colaborador'
  const [recipientType, setRecipientType] = useState(initialType)
  const [employee, setEmployee] = useState(
    employees.some((e) => e.id === editing?.employee_id) ? editing.employee_id : '',
  )
  const selected = recipientType === 'Colaborador' ? employees.find((e) => e.id === employee) : null

  const [cep, setCep] = useState(() => formatCep(editing?.cep || ''))
  const [cepDetails, setCepDetails] = useState(() => resolveCepLocation(editing?.cep || ''))
  const [uf, setUf] = useState(() => editing?.state || selected?.state || '')
  const [chargeProject, setChargeProject] = useState(() =>
    editing ? inferChargeProject(editing) : initialType === 'Colaborador',
  )
  const [chosenProject, setChosenProject] = useState(() => {
    if (editing?.project && !['SSMA', 'Setor Facilities'].includes(editing.project)) return editing.project
    return selected?.project || projects[0] || ''
  })
  const [adminCostCenter, setAdminCostCenter] = useState(() =>
    editing?.project === 'Setor Facilities' ? 'Setor Facilities' : 'SSMA',
  )

  const allowedStates = profile.is_master ? states : profile.coverage || []

  useEffect(() => {
    const digits = cleanCep(cep)
    if (digits.length !== 8) {
      setCepDetails(null)
      return
    }
    const instant = resolveCepLocation(digits)
    if (instant) {
      setCepDetails(instant)
      setUf(instant.uf)
    }
    const controller = new AbortController()
    lookupCepDetails(digits, controller.signal).then((info) => {
      if (!controller.signal.aborted && info) {
        setCepDetails(info)
        if (info.uf) setUf(info.uf)
      }
    })
    return () => controller.abort()
  }, [cep])

  function handleRecipientTypeChange(nextType) {
    setRecipientType(nextType)
    if (nextType === 'Colaborador') {
      setChargeProject(true)
      if (selected?.project) setChosenProject(selected.project)
      if (!cleanCep(cep) && selected?.state) setUf(selected.state)
    } else {
      setEmployee('')
      setChargeProject(false)
    }
  }

  function handleEmployeeChange(empId) {
    setEmployee(empId)
    const found = employees.find((e) => e.id === empId)
    if (found) {
      setChosenProject(found.project)
      setChargeProject(true)
      if (cleanCep(cep).length !== 8 && found.state) setUf(found.state)
    }
  }

  const projectOptions = useMemo(() => {
    const set = new Set(projects.filter(Boolean))
    for (const e of employees) if (e.project) set.add(e.project)
    if (chosenProject && !['SSMA', 'Setor Facilities'].includes(chosenProject)) set.add(chosenProject)
    return [...set].sort((a, b) => a.localeCompare(b, 'pt-BR'))
  }, [projects, employees, chosenProject])

  const computedRegion = regionOf(uf) || cepDetails?.region || ''
  const outOfCoverage = Boolean(uf && !profile.is_master && !allowedStates.includes(uf))

  return (
    <ActionForm
      submit={editing ? 'Salvar alterações do envio' : 'Registrar envio'}
      onSave={(p) => {
        const finalProject = chargeProject
          ? p.project_target || selected?.project || chosenProject
          : p.admin_target || adminCostCenter || 'SSMA'
        return save({
          id: p.id,
          unit_id: unit,
          date: p.date,
          tracking: p.tracking,
          mode: p.mode,
          cep: formatCep(cep),
          recipient_type: recipientType,
          employee_id: recipientType === 'Colaborador' && employee ? employee : '',
          recipient: recipientType === 'Colaborador' && selected ? selected.name : p.recipient,
          state: uf || selected?.state || '',
          charge_project: chargeProject,
          project: finalProject,
          price: p.price,
        })
      }}
    >
      <Field label="Data de envio" type="date" name="date" required defaultValue={editing?.sent || today()} />
      <Field
        label="Código de rastreamento"
        name="tracking"
        defaultValue={editing?.tracking}
        required
        minLength={4}
        maxLength={64}
      />
      <Select
        label="Modalidade de entrega"
        name="mode"
        defaultValue={editing?.mode}
        required
        options={['PAC', 'SEDEX', 'SEDEX 10', 'SEDEX 12', 'SEDEX Hoje', 'Mini Envios', 'Carta registrada', 'Outra']}
      />

      {/* CEP para localização automática da Região e UF */}
      <Field
        label="CEP de destino"
        name="cep_input"
        placeholder="00000-000"
        inputMode="numeric"
        maxLength={9}
        value={cep}
        onChange={(e) => setCep(formatCep(e.target.value))}
      />

      {/* Tipo de destinatário: Colaborador, Fornecedor ou Outros */}
      <Select
        label="Tipo de destinatário"
        name="recipient_type"
        value={recipientType}
        onChange={(e) => handleRecipientTypeChange(e.target.value)}
        options={[
          ['Colaborador', 'Colaborador'],
          ['Fornecedor', 'Fornecedor'],
          ['Outros', 'Outros'],
        ]}
        required
      />

      {recipientType === 'Colaborador' ? (
        <>
          <Select
            label="Colaborador cadastrado"
            name="employee_id"
            placeholder="Digitar nome manualmente"
            options={employees.map((e) => [e.id, `${e.name} · ${e.project} (${e.state})`])}
            value={employee}
            onChange={(e) => handleEmployeeChange(e.target.value)}
          />
          {!selected && (
            <Field
              label="Nome do colaborador"
              name="recipient"
              defaultValue={editing?.recipient}
              required
              maxLength={200}
            />
          )}
        </>
      ) : (
        <Field
          label={recipientType === 'Fornecedor' ? 'Nome do fornecedor / empresa' : 'Nome do destinatário ou órgão'}
          name="recipient"
          defaultValue={editing?.employee_id ? '' : editing?.recipient}
          required
          maxLength={200}
        />
      )}

      <Select
        label="UF de destino"
        name="state"
        value={uf}
        onChange={(e) => setUf(e.target.value)}
        required
        placeholder="Selecione ou informe o CEP"
        options={
          uf && !allowedStates.includes(uf)
            ? [...allowedStates, [uf, `${uf} (identificado pelo CEP)`]]
            : allowedStates
        }
      />

      {/* Decisão explícita: o custo vai para o projeto ou não? */}
      <Select
        label="Custo vai para o projeto?"
        name="charge_decision"
        value={chargeProject ? 'sim' : 'nao'}
        onChange={(e) => setChargeProject(e.target.value === 'sim')}
        options={[
          ['sim', 'Sim — Alocar custo ao Projeto'],
          ['nao', 'Não — Custo administrativo (SSMA / Facilities)'],
        ]}
        required
      />

      {chargeProject ? (
        projectOptions.length > 0 ? (
          <Select
            label="Projeto que receberá o custo"
            name="project_target"
            value={selected ? selected.project : chosenProject}
            onChange={(e) => setChosenProject(e.target.value)}
            options={projectOptions}
            required
          />
        ) : (
          <Field
            label="Projeto que receberá o custo"
            name="project_target"
            value={chosenProject}
            onChange={(e) => setChosenProject(e.target.value)}
            required
            maxLength={120}
          />
        )
      ) : (
        <Select
          label="Centro administrativo do custo"
          name="admin_target"
          value={adminCostCenter}
          onChange={(e) => setAdminCostCenter(e.target.value)}
          options={[
            ['SSMA', 'SSMA (Não alocado ao projeto)'],
            ['Setor Facilities', 'Setor Facilities (Não alocado ao projeto)'],
          ]}
          required
        />
      )}

      <PriceField label="Valor do envio (R$)" initialValue={editing?.cost} required />

      {(computedRegion || cepDetails) && (
        <div className={'cep-region-badge' + (outOfCoverage ? ' warning' : '')} style={{ flexBasis: '100%' }}>
          <MapPin size={16} aria-hidden="true" />
          <span>
            Região identificada: <strong>{computedRegion || '—'}</strong>
            {uf && (
              <>
                {' · '}UF <strong>{uf}</strong>
              </>
            )}
            {cepDetails?.city && (
              <>
                {' · '}
                {cepDetails.city}
                {cepDetails.neighborhood ? ` (${cepDetails.neighborhood})` : ''}
              </>
            )}
            {outOfCoverage && ' — Atenção: esta UF não faz parte da cobertura atual do seu perfil.'}
          </span>
        </div>
      )}
    </ActionForm>
  )
}

export function Logistics({ db, profile, shipping = false, onSaved }) {
  const [data, setData] = useState(null),
    [error, setError] = useState(''),
    [form, setForm] = useState(false),
    [choice, setChoice] = useState(''),
    [revision, setRevision] = useState(0)
  const [editing, setEditing] = useState(null),
    [confirm, setConfirm] = useState(null),
    [removing, setRemoving] = useState(false),
    [mutationError, setMutationError] = useState('')
  const [notice, setNotice] = useState('')

  // Filtros avançados de Período, Tipo, Região, Busca e Paginação numérica (até 25 por página)
  const [periodPreset, setPeriodPreset] = useState('all')
  const [range, setRange] = useState({ start: '', end: '' })
  const [typeFilter, setTypeFilter] = useState('')
  const [regionFilter, setRegionFilter] = useState('')
  const [unitFilter, setUnitFilter] = useState('')
  const [searchTerm, setSearchTerm] = useState('')
  const [pageSize, setPageSize] = useState(25)
  const [currentPage, setCurrentPage] = useState(1)

  useEffect(() => {
    let active = true
    setError('')
    rpc(db, 'logistics', { action: shipping ? 'shipments' : 'invoices', p: {} })
      .then((d) => {
        if (active) setData(d)
      })
      .catch((e) => {
        if (active) setError(e.message)
      })
    return () => {
      active = false
    }
  }, [db, shipping, revision])

  function applyPeriodPreset(val) {
    setPeriodPreset(val)
    if (val === 'all') {
      setRange({ start: '', end: '' })
    } else if (val !== 'custom') {
      setRange(recentPeriod(Number(val), today()))
    }
    setCurrentPage(1)
  }

  function handleCustomRange(nextRange) {
    setPeriodPreset('custom')
    setRange(nextRange)
    setCurrentPage(1)
  }

  const unit =
    editing?.unit_id ||
    (profile.is_master
      ? choice || (data?.units.length === 1 ? data.units[0].id : '')
      : profile.stock_unit || profile.user_id)

  async function save(p) {
    const action = (editing ? 'edit_' : '') + (shipping ? 'ship' : 'invoice')
    await rpc(db, 'logistics', { action, p: editing ? { ...p, id: editing.id, previous: editing.request_hash } : p })
    setForm(false)
    setEditing(null)
    setNotice(shipping ? 'Envio salvo.' : 'Nota salva e estoque atualizado.')
    setRevision((n) => n + 1)
    onSaved?.()
  }

  async function remove() {
    if (removing || !confirm) return
    setRemoving(true)
    setMutationError('')
    try {
      await rpc(db, 'logistics', {
        action: shipping ? 'delete_ship' : 'delete_invoice',
        p: { id: confirm.id, unit_id: confirm.unit_id, previous: confirm.request_hash },
      })
      setConfirm(null)
      setNotice(shipping ? 'Envio excluído.' : 'Nota excluída e estoque atualizado.')
      setRevision((n) => n + 1)
      onSaved?.()
    } catch (err) {
      setMutationError(err.message)
    } finally {
      setRemoving(false)
    }
  }

  function actions(row) {
    return (
      <div className="table-icon-actions">
        <button
          className="icon-action"
          title="Editar"
          aria-label="Editar"
          disabled={removing}
          onClick={() => {
            setEditing(row)
            setForm(true)
            setConfirm(null)
            setNotice('')
            setMutationError('')
          }}
        >
          <Pencil size={15} aria-hidden="true" />
        </button>
        <button
          className="icon-action danger"
          title="Excluir"
          aria-label="Excluir"
          disabled={removing}
          onClick={() => {
            setConfirm(row)
            setForm(false)
            setEditing(null)
            setNotice('')
            setMutationError('')
          }}
        >
          <Trash2 size={15} aria-hidden="true" />
        </button>
      </div>
    )
  }

  const rows = useMemo(() => {
    if (!data?.rows) return []
    const q = searchTerm.trim().toLocaleLowerCase('pt-BR')
    return data.rows.filter((r) => {
      if (!within(shipping ? r.sent : r.issued, range)) return false
      if (!shipping) return true
      if (unitFilter && r.unit_id !== unitFilter) return false
      const rType = inferRecipientType(r)
      if (typeFilter && rType !== typeFilter) return false
      const rReg = regionOf(r.state)
      if (regionFilter && rReg !== regionFilter) return false
      if (q) {
        const hay = [r.tracking, r.recipient, r.project, r.cep, r.state, rReg, rType]
          .join(' ')
          .toLocaleLowerCase('pt-BR')
        if (!hay.includes(q)) return false
      }
      return true
    })
  }, [data?.rows, shipping, range, unitFilter, typeFilter, regionFilter, searchTerm])

  const safeLimit = Math.min(25, Math.max(1, Number(pageSize) || 25))
  const totalPages = Math.max(1, Math.ceil(rows.length / safeLimit))
  const activePage = Math.min(currentPage, totalPages)
  const pagedRows = shipping ? rows.slice((activePage - 1) * safeLimit, activePage * safeLimit) : rows

  const pageNumbers = useMemo(() => {
    return Array.from({ length: totalPages }, (_, i) => i + 1).filter(
      (n) => n === 1 || n === totalPages || Math.abs(n - activePage) <= 2,
    )
  }, [totalPages, activePage])

  if (error)
    return (
      <p role="alert">
        {error}{' '}
        <button className="secondary" onClick={() => setRevision((n) => n + 1)}>
          Tentar novamente
        </button>
      </p>
    )
  if (!data) return <Skeleton label="Carregando lançamentos…" />

  const totalShipping = rows.reduce((v, s) => v + Math.round(Number(s.cost || 0) * 100), 0) / 100
  const projectShipping =
    rows.filter((s) => inferChargeProject(s)).reduce((v, s) => v + Math.round(Number(s.cost || 0) * 100), 0) / 100
  const adminShipping =
    rows.filter((s) => !inferChargeProject(s)).reduce((v, s) => v + Math.round(Number(s.cost || 0) * 100), 0) / 100

  return (
    <Panel
      title={shipping ? 'Envios pelos Correios' : 'Notas fiscais de entrada'}
      icon={shipping ? <Truck size={21} aria-hidden="true" /> : undefined}
      className={shipping ? 'epi-shipping-panel' : form ? 'epi-invoice-panel expanded' : 'epi-invoice-panel'}
      action={
        <button
          className="primary btn-compact"
          onClick={() => {
            setEditing(null)
            setConfirm(null)
            setForm(!form)
            setNotice('')
            setMutationError('')
          }}
        >
          <CirclePlus size={16} aria-hidden="true" />{' '}
          {form ? 'Fechar cadastro' : shipping ? 'Cadastrar envio' : 'Inserir nota fiscal'}
        </button>
      }
    >
      {notice && (
        <p className="epi-success" role="status">
          {notice}
        </p>
      )}
      {mutationError && (
        <p role="alert" className="form-error">
          {mutationError}
        </p>
      )}
      {confirm && (
        <div className="notice">
          <p>
            {shipping
              ? 'Excluir o envio ' + confirm.tracking + ' e descontar seu frete dos totais?'
              : 'Excluir a nota ' + confirm.number + ' e descontar seus itens do estoque?'}
          </p>
          <div className="button-group">
            <button className="secondary" disabled={removing} onClick={() => setConfirm(null)}>
              Cancelar
            </button>
            <button className="primary" disabled={removing} onClick={remove}>
              Confirmar exclusão
            </button>
          </div>
        </div>
      )}
      {form && (
        <>
          {profile.is_master && !editing && (
            <Select
              label="Estoque do lançamento"
              value={unit}
              onChange={(e) => setChoice(e.target.value)}
              options={data.units.map((u) => [u.id, u.name])}
            />
          )}
          {unit &&
            (shipping ? (
              <ShippingForm
                key={editing?.id || unit}
                editing={editing}
                employees={profile.is_master ? data.employees : data.employees.filter((e) => e.unit === unit)}
                projects={data.projects || []}
                profile={profile}
                unit={unit}
                save={save}
              />
            ) : (
              <InvoiceForm
                db={db}
                key={editing?.id || unit}
                editing={editing}
                unit={unit}
                materials={data.materials.filter((m) => m.region_id === unit)}
                save={save}
              />
            ))}
        </>
      )}

      {shipping ? (
        <>
          {/* Resumo Financeiro de Correios (Total, Custo Projeto vs Fornecedor/Outros/SSMA) */}
          <div className="epi-shipping-kpis">
            <div className="epi-shipping-total">
              <span className="epi-shipping-total-icon">
                <Coins size={20} aria-hidden="true" />
              </span>
              <div>
                <small>Gasto total no período ({rows.length} envios)</small>
                <strong>{money(totalShipping)}</strong>
              </div>
            </div>
            <div className="epi-shipping-total">
              <span className="epi-shipping-total-icon tone-blue">
                <Briefcase size={19} aria-hidden="true" />
              </span>
              <div>
                <small>Custo alocado aos Projetos</small>
                <strong>{money(projectShipping)}</strong>
              </div>
            </div>
            <div className="epi-shipping-total">
              <span className="epi-shipping-total-icon tone-amber">
                <Building2 size={19} aria-hidden="true" />
              </span>
              <div>
                <small>Fornecedor / Outros (Fora de Projeto)</small>
                <strong>{money(adminShipping)}</strong>
              </div>
            </div>
          </div>

          {/* Barra de Filtragem por Período, Tipo, Região e Limite por Página */}
          <div className="epi-filters epi-shipping-filters">
            <Select
              label="Filtrar por período"
              value={periodPreset}
              onChange={(e) => applyPeriodPreset(e.target.value)}
              options={[
                ['all', 'Todo o período'],
                ['7', 'Últimos 7 dias'],
                ['30', 'Últimos 30 dias'],
                ['90', 'Últimos 90 dias'],
                ['365', 'Últimos 12 meses'],
                ['custom', 'Período personalizado'],
              ]}
            />
            <Field
              type="date"
              label="Data inicial"
              value={range.start}
              max={range.end || undefined}
              onChange={(e) => handleCustomRange({ ...range, start: e.target.value })}
            />
            <Field
              type="date"
              label="Data final"
              value={range.end}
              min={range.start || undefined}
              onChange={(e) => handleCustomRange({ ...range, end: e.target.value })}
            />
            <Select
              label="Tipo de destinatário"
              placeholder="Todos os tipos"
              value={typeFilter}
              onChange={(e) => {
                setTypeFilter(e.target.value)
                setCurrentPage(1)
              }}
              options={RECIPIENT_TYPES}
            />
            <Select
              label="Região"
              placeholder="Todas as regiões"
              value={regionFilter}
              onChange={(e) => {
                setRegionFilter(e.target.value)
                setCurrentPage(1)
              }}
              options={Object.keys(stockAreas)}
            />
            {profile.is_master && data.units?.length > 1 && (
              <Select
                label="Unidade de estoque"
                placeholder="Todas as unidades"
                value={unitFilter}
                onChange={(e) => {
                  setUnitFilter(e.target.value)
                  setCurrentPage(1)
                }}
                options={data.units.map((u) => [u.id, u.name])}
              />
            )}
            <Field
              label="Buscar envio"
              type="search"
              icon={<Search size={15} aria-hidden="true" />}
              placeholder="Rastreio, destinatário, CEP ou projeto"
              value={searchTerm}
              onChange={(e) => {
                setSearchTerm(e.target.value)
                setCurrentPage(1)
              }}
            />
            <Select
              label="Limite por página"
              value={String(safeLimit)}
              onChange={(e) => {
                setPageSize(Math.min(25, Number(e.target.value) || 25))
                setCurrentPage(1)
              }}
              options={PAGE_LIMIT_OPTIONS}
            />
          </div>

          {rows.length > 0 ? (
            <>
              <div className="epi-split">
                <Table
                  headers={['Região', 'Gasto com envios']}
                  rows={totalsBy(
                    rows,
                    (s) => regionOf(s.state) || 'Sem região',
                    (s) => Math.round(Number(s.cost || 0) * 100),
                  )}
                />
                <Table
                  headers={['Destino do custo', 'Gasto com envios']}
                  rows={totalsBy(
                    rows,
                    (s) => (inferChargeProject(s) ? `Projeto · ${s.project}` : `Fora de projeto · ${s.project}`),
                    (s) => Math.round(Number(s.cost || 0) * 100),
                  )}
                />
              </div>

              <Table
                headers={[
                  'Data',
                  'Rastreio',
                  'Tipo',
                  'Destinatário',
                  'CEP / Região / UF',
                  'Alocação de custo',
                  'Modalidade',
                  'Valor',
                  'Ações',
                ]}
                rows={pagedRows.map((s) => {
                  const rType = inferRecipientType(s)
                  const toProj = inferChargeProject(s)
                  const regName = regionOf(s.state)
                  return [
                    dateLabel(s.sent),
                    <strong className="material-strong">{s.tracking}</strong>,
                    <span
                      className={
                        'badge badge-icon ' +
                        (rType === 'Colaborador' ? 'green' : rType === 'Fornecedor' ? 'blue' : 'gray')
                      }
                    >
                      {rType === 'Colaborador' ? <UserCheck size={12} aria-hidden="true" /> : null}
                      <span>{rType}</span>
                    </span>,
                    s.recipient,
                    <div className="shipping-loc-cell">
                      {s.cep && <span className="ca-pill">{s.cep}</span>}
                      <span>{regName ? `${regName} · ` : ''}</span>
                      <span className="uf-pill">{s.state}</span>
                    </div>,
                    <div>
                      <span className={'badge ' + (toProj ? 'green' : 'gray')}>
                        {toProj ? 'Custo no Projeto' : 'Fora do Projeto'}
                      </span>
                      <small style={{ display: 'block', marginTop: 3 }}>{s.project}</small>
                    </div>,
                    s.mode,
                    <strong className="money-strong">{money(s.cost)}</strong>,
                    actions(s),
                  ]
                })}
              />

              {/* Paginação Numérica (limite de até 25 por página) */}
              <div className="shipping-pagination-bar">
                <span className="shipping-pagination-info">
                  Exibindo <strong>{(activePage - 1) * safeLimit + 1}</strong>–
                  <strong>{Math.min(activePage * safeLimit, rows.length)}</strong> de <strong>{rows.length}</strong>{' '}
                  envio(s) · até {safeLimit} por página
                </span>
                <nav className="page-numbers" aria-label="Paginação de envios dos Correios">
                  <button
                    type="button"
                    className="secondary"
                    disabled={activePage <= 1}
                    onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                  >
                    Anterior
                  </button>
                  {pageNumbers.map((n, i) => (
                    <React.Fragment key={n}>
                      {i > 0 && n > pageNumbers[i - 1] + 1 && <span>…</span>}
                      <button
                        type="button"
                        className={activePage === n ? 'primary' : 'secondary'}
                        aria-current={activePage === n ? 'page' : undefined}
                        aria-label={'Página ' + n}
                        onClick={() => setCurrentPage(n)}
                      >
                        {n}
                      </button>
                    </React.Fragment>
                  ))}
                  <button
                    type="button"
                    className="secondary"
                    disabled={activePage >= totalPages}
                    onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                  >
                    Próxima
                  </button>
                </nav>
              </div>
            </>
          ) : (
            <div className="epi-empty-hero">
              <span className="epi-empty-circle">
                <Package size={30} aria-hidden="true" />
              </span>
              <h3>Nenhum envio encontrado</h3>
              <p>Ajuste os filtros de período, tipo ou região, ou cadastre um novo envio.</p>
            </div>
          )}
        </>
      ) : (
        <>
          <DateRange value={range} onChange={setRange} />
          {rows.length > 0 ? (
            <Table
              headers={['Emissão', 'Nota fiscal', 'Série', 'CNPJ', 'Itens', 'Valor total', 'Ações']}
              rows={rows.map((n) => [
                dateLabel(n.issued),
                <strong className="material-strong">{n.number}</strong>,
                n.series || '—',
                n.cnpj,
                n.items.length,
                <strong className="money-strong">{money(n.total)}</strong>,
                actions(n),
              ])}
            />
          ) : (
            <div className="epi-empty-invoice">
              <FileText size={36} aria-hidden="true" />
              <p>Nenhuma nota fiscal no período</p>
            </div>
          )}
        </>
      )}
    </Panel>
  )
}
