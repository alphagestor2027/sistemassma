import React from 'react'
import { Download, FileSpreadsheet, ChevronRight, Package, X } from 'lucide-react'
import { Panel, Table, Field } from './EpiShared'
import { money, regionLabel, regionOf, stamp, variant } from './epiData'
import { today } from './data'
import { buildConsolidatedStockBytes, triggerXlsxDownload } from './spreadsheet'

export function within(timestamp, { start, end }) {
  if (!timestamp) return false
  const day =
    timestamp.length === 10
      ? timestamp
      : new Date(timestamp).toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' })
  return (!start || day >= start) && (!end || day <= end)
}

export function DateRange({ value, onChange, compact = false }) {
  return (
    <div className={'epi-filters epi-date-range' + (compact ? ' compact' : '')}>
      <Field
        type="date"
        label="Data inicial"
        value={value.start}
        max={value.end || undefined}
        onChange={(e) => onChange({ ...value, start: e.target.value })}
      />
      <Field
        type="date"
        label="Data final"
        value={value.end}
        min={value.start || undefined}
        onChange={(e) => onChange({ ...value, end: e.target.value })}
      />
      {value.start && value.end && value.start > value.end && (
        <p role="alert">A data inicial precisa vir antes da data final.</p>
      )}
    </div>
  )
}

export function totalsBy(rows, key, cents) {
  const totals = new Map()
  for (const r of rows) {
    const label = key(r) || 'Sem informação'
    totals.set(label, (totals.get(label) || 0) + cents(r))
  }
  return [...totals]
    .sort((a, b) => b[1] - a[1])
    .map(([name, v]) => [name, <strong className="money-cell">{money(v / 100)}</strong>])
}

function groupedEntries(rows, key, cents) {
  const totals = new Map()
  for (const r of rows) {
    const label = key(r) || 'Sem informação'
    totals.set(label, (totals.get(label) || 0) + cents(r))
  }
  return [...totals].sort((a, b) => b[1] - a[1])
}

export function CostBreakdown({ requests }) {
  const [selected, setSelected] = React.useState(null) // { kind: 'project' | 'region', label: string }
  const rows = requests.filter((q) => q.status === 'Entregue' && q.destination === 'Projeto')
  const cents = (q) => q.items.reduce((v, i) => v + i.qty * Math.round(Number(i.price) * 100), 0)

  const byProject = groupedEntries(rows, (q) => q.project, cents)
  const byRegion = groupedEntries(rows, (q) => regionOf(q.state), cents)

  function toggleSelection(kind, label) {
    setSelected((prev) => (prev?.kind === kind && prev?.label === label ? null : { kind, label }))
  }

  const detailItems = React.useMemo(() => {
    if (!selected) return []
    const matchingRequests = rows.filter((q) =>
      selected.kind === 'project'
        ? (q.project || 'Sem informação') === selected.label
        : (regionOf(q.state) || 'Sem informação') === selected.label,
    )
    const aggregated = new Map()
    for (const q of matchingRequests) {
      for (const item of q.items || []) {
        const matName = variant(item)
        const key = `${q.project}|${q.state}|${item.material_id || matName}`
        const cur = aggregated.get(key) || {
          material: matName,
          ca: item.ca || 'Sem CA',
          project: q.project || '—',
          state: q.state || '—',
          employees: new Set(),
          lastDate: q.closed_at || q.created_at,
          qty: 0,
          cents: 0,
        }
        if (q.employee) cur.employees.add(q.employee)
        if ((q.closed_at || q.created_at) > cur.lastDate) cur.lastDate = q.closed_at || q.created_at
        cur.qty += Number(item.qty || 0)
        cur.cents += Number(item.qty || 0) * Math.round(Number(item.price || 0) * 100)
        aggregated.set(key, cur)
      }
    }
    return [...aggregated.values()].sort((a, b) => b.cents - a.cents)
  }, [rows, selected])

  const detailTotalCents = detailItems.reduce((s, x) => s + x.cents, 0)

  return (
    <Panel
      title="Valor entregue por projeto e região"
      className="epi-cost-panel"
      action={<small className="epi-click-hint">Clique em um projeto ou região para ver os materiais enviados</small>}
    >
      <div className="epi-split">
        <Table
          headers={['Projeto', 'Valor']}
          rows={byProject.map(([name, valCents]) => {
            const active = selected?.kind === 'project' && selected?.label === name
            return [
              <button
                type="button"
                className={'epi-breakdown-link' + (active ? ' is-active' : '')}
                onClick={() => toggleSelection('project', name)}
              >
                <ChevronRight size={15} className="epi-breakdown-chevron" aria-hidden="true" />
                <span>{name}</span>
              </button>,
              <strong className="money-cell">{money(valCents / 100)}</strong>,
            ]
          })}
          empty="Nenhuma entrega por projeto no período."
        />

        <Table
          headers={['Região', 'Valor']}
          rows={byRegion.map(([name, valCents]) => {
            const active = selected?.kind === 'region' && selected?.label === name
            return [
              <button
                type="button"
                className={'epi-breakdown-link' + (active ? ' is-active' : '')}
                onClick={() => toggleSelection('region', name)}
              >
                <ChevronRight size={15} className="epi-breakdown-chevron" aria-hidden="true" />
                <span>{name}</span>
              </button>,
              <strong className="money-cell">{money(valCents / 100)}</strong>,
            ]
          })}
          empty="Nenhuma entrega por região no período."
        />
      </div>

      {selected && (
        <section className="epi-project-materials-drawer" aria-live="polite">
          <header className="epi-project-materials-head">
            <div>
              <h3>
                <Package size={17} aria-hidden="true" /> Materiais enviados para{' '}
                {selected.kind === 'project' ? `o projeto ${selected.label}` : `a região ${selected.label}`}
              </h3>
              <small>
                {detailItems.reduce((s, i) => s + i.qty, 0)} unidade(s) entregue(s) · Total:{' '}
                <strong>{money(detailTotalCents / 100)}</strong>
              </small>
            </div>
            <button type="button" className="secondary btn-sm" onClick={() => setSelected(null)}>
              <X size={14} aria-hidden="true" /> Fechar materiais
            </button>
          </header>

          <Table
            headers={[
              'Material enviado',
              'CA',
              selected.kind === 'region' ? 'Projeto' : 'Colaborador(es)',
              'UF',
              'Última entrega',
              'Qtd.',
              'Valor total',
            ]}
            rows={detailItems.map((it) => [
              <strong className="material-strong">{it.material}</strong>,
              <span className="ca-pill">{it.ca}</span>,
              selected.kind === 'region' ? it.project : [...it.employees].join(', ') || '—',
              it.state ? <span className="uf-pill">{it.state}</span> : '—',
              it.lastDate ? stamp(it.lastDate) : '—',
              <span className="num-cell">{it.qty}</span>,
              <strong className="money-strong">{money(it.cents / 100)}</strong>,
            ])}
            empty="Nenhum material enviado encontrado para esta seleção."
          />
        </section>
      )}
    </Panel>
  )
}

export function Consolidated({ data, db }) {
  const [costs, setCosts] = React.useState(null),
    [failed, setFailed] = React.useState(false),
    [retry, setRetry] = React.useState(0)

  React.useEffect(() => {
    let active = true
    setFailed(false)
    db.rpc('ssma_epi_stock_costs').then(({ data, error }) => {
      if (active) {
        setFailed(Boolean(error))
        setCosts(data || [])
      }
    })
    return () => {
      active = false
    }
  }, [db, retry])

  const parents = new Map()
  const normalize = (ca) => String(ca || '').trim().replace(/^0+(?=\d)/, '')
  for (const m of data.materials) {
    for (const generic of m.generic_cas || []) parents.set(normalize(generic), normalize(m.ca))
  }
  const principal = (ca) => {
    let code = normalize(ca)
    const seen = new Set()
    while (parents.has(code) && !seen.has(code)) {
      seen.add(code)
      code = parents.get(code)
    }
    return code
  }

  const projectsByRegionId = new Map()
  const macroRegionsByRegionId = new Map()
  for (const r of data.regions || []) {
    const mr = regionOf(r.state)
    if (mr) macroRegionsByRegionId.set(r.id, new Set([mr]))
  }
  for (const a of data.assignments || []) {
    if (a.active === false) continue
    if (a.project) {
      if (!projectsByRegionId.has(a.region_id)) projectsByRegionId.set(a.region_id, new Set())
      projectsByRegionId.get(a.region_id).add(a.project)
    }
    const mr = regionOf(a.state)
    if (mr) {
      if (!macroRegionsByRegionId.has(a.region_id)) macroRegionsByRegionId.set(a.region_id, new Set())
      macroRegionsByRegionId.get(a.region_id).add(mr)
    }
  }
  for (const q of data.requests || []) {
    if (q.project) {
      if (!projectsByRegionId.has(q.region_id)) projectsByRegionId.set(q.region_id, new Set())
      projectsByRegionId.get(q.region_id).add(q.project)
    }
    const mr = regionOf(q.state)
    if (mr) {
      if (!macroRegionsByRegionId.has(q.region_id)) macroRegionsByRegionId.set(q.region_id, new Set())
      macroRegionsByRegionId.get(q.region_id).add(mr)
    }
  }

  const groups = new Map()
  for (const m of data.materials) {
    const ca = m.no_ca ? '' : principal(m.ca)
    const key = ca ? 'ca:' + ca : 'nome:' + m.name.trim().toLocaleLowerCase('pt-BR')
    const g = groups.get(key) || {
      names: new Set(),
      aliases: new Set(),
      projects: new Set(),
      regions: new Set(),
      ca,
      qty: 0,
      cents: 0,
    }
    for (const alias of m.generic_cas || []) g.aliases.add(alias)
    if (!m.no_ca && normalize(m.ca) && normalize(m.ca) !== ca) g.aliases.add(normalize(m.ca))
    g.names.add(m.name)
    g.qty += m.qty
    g.cents += m.qty * Math.round(Number(m.price) * 100)

    const regObj = (data.regions || []).find((r) => r.id === m.region_id)
    const linkedProjects = projectsByRegionId.get(m.region_id)
    if (linkedProjects?.size) {
      for (const p of linkedProjects) g.projects.add(p)
    } else if (regObj) {
      g.projects.add(regionLabel(regObj))
    }

    const linkedRegions = macroRegionsByRegionId.get(m.region_id)
    if (linkedRegions?.size) {
      for (const mr of linkedRegions) g.regions.add(mr)
    } else if (regObj?.state && regionOf(regObj.state)) {
      g.regions.add(regionOf(regObj.state))
    }
    groups.set(key, g)
  }

  const genericsByCa = new Map()
  for (const g of groups.values()) {
    if (g.ca) genericsByCa.set(g.ca, [...g.aliases].join(', '))
  }

  const deliveries = new Map()
  for (const row of costs || []) {
    const ca = principal(row.ca),
      region = regionOf(row.state),
      key = JSON.stringify([row.project, region, ca || row.material])
    const group = deliveries.get(key) || { project: row.project, region, ca, names: new Set(), qty: 0, cents: 0 }
    group.names.add(row.material)
    group.qty += Number(row.qty)
    group.cents += Math.round(Number(row.cost) * 100)
    deliveries.set(key, group)
  }

  function handleExportConsolidated() {
    const stockExportRows = [...groups.values()].map((g) => ({
      material: [...g.names].join(' / '),
      ca: g.ca || 'Sem CA',
      generics: [...g.aliases].join(', ') || '—',
      qty: g.qty,
      project: [...g.projects].join(', ') || 'Estoque Geral',
      region: [...g.regions].join(', ') || 'Todas',
    }))

    const deliveryExportRows = [...deliveries.values()].map((r) => ({
      material: [...r.names].join(' / '),
      ca: r.ca || 'Sem CA',
      generics: (r.ca && genericsByCa.get(r.ca)) || '—',
      qty: r.qty,
      project: r.project || '—',
      region: r.region || '—',
    }))

    const bytes = buildConsolidatedStockBytes(stockExportRows, deliveryExportRows)
    triggerXlsxDownload(bytes, `Estoque_Consolidado_SSMA_${today()}.xlsx`)
  }

  return (
    <>
      <Panel
        title="Estoque consolidado por CA"
        className="epi-consolidated-panel"
        action={
          <button
            type="button"
            className="btn-green"
            onClick={handleExportConsolidated}
            disabled={groups.size === 0 && deliveries.size === 0}
            title="Exportar planilha Excel formatada na identidade visual verde"
          >
            <FileSpreadsheet size={16} aria-hidden="true" />
            <Download size={15} aria-hidden="true" /> Exportar em planilha (.xlsx)
          </button>
        }
      >
        <Table
          headers={[
            'Material',
            'CA principal',
            'CAs genéricos',
            'Projeto',
            'Região',
            'Quantidade',
            'Valor médio unitário',
            'Valor total em estoque',
          ]}
          rows={[...groups.values()].map((g) => [
            <strong className="material-strong">{[...g.names].join(' / ')}</strong>,
            <span className="ca-pill">{g.ca || 'Sem CA'}</span>,
            [...g.aliases].join(', ') || '—',
            [...g.projects].join(', ') || '—',
            [...g.regions].join(', ') || '—',
            <span className="num-cell">{g.qty}</span>,
            <span className="num-cell">{g.qty ? money(g.cents / g.qty / 100) : '—'}</span>,
            <span className={g.cents > 0 ? 'money-strong' : 'money-muted'}>{money(g.cents / 100)}</span>,
          ])}
        />
      </Panel>
      <Panel title="Distribuição por projeto e região">
        {failed ? (
          <button className="secondary" onClick={() => setRetry((n) => n + 1)}>
            Falha ao consultar. Tentar novamente
          </button>
        ) : costs === null ? (
          <p>Carregando distribuição…</p>
        ) : (
          <Table
            headers={['Projeto', 'Região', 'Material', 'CA Principal', 'CA Genérico', 'Quantidade entregue', 'Valor entregue']}
            rows={[...deliveries.values()].map((r) => [
              <strong className="material-strong">{r.project}</strong>,
              r.region || '—',
              [...r.names].join(' / '),
              <span className="ca-pill">{r.ca || 'Sem CA'}</span>,
              (r.ca && genericsByCa.get(r.ca)) || '—',
              r.qty,
              <span className="money-strong">{money(r.cents / 100)}</span>,
            ])}
          />
        )}
      </Panel>
    </>
  )
}
