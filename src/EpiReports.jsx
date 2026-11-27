import React from 'react'
import { Download, FileSpreadsheet, ChevronRight, Package, X, Layers, Boxes, Wallet } from 'lucide-react'
import { Panel, Table, Field } from './EpiShared'
import { money, regionLabel, regionOf, stamp, variant } from './epiData'
import { today } from './data'
import { buildConsolidatedStockBytes, buildDeliveredPeriodBytes, triggerXlsxDownload } from './spreadsheet'

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

function aggregateDeliveredItems(matchingRequests) {
  const aggregated = new Map()
  for (const q of matchingRequests) {
    const reg = regionOf(q.state) || 'Sem informação'
    for (const item of q.items || []) {
      const matName = variant(item)
      const key = `${q.project || 'Sem informação'}|${reg}|${q.state || ''}|${item.material_id || matName}`
      const cur = aggregated.get(key) || {
        material: matName,
        ca: item.ca || 'Sem CA',
        project: q.project || 'Sem informação',
        region: reg,
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
}

export function CostBreakdown({ requests, range: parentRange }) {
  const [selected, setSelected] = React.useState(null) // { kind: 'project' | 'region', label: string }
  const [period, setPeriod] = React.useState(() => parentRange || { start: '', end: '' })

  React.useEffect(() => {
    if (parentRange) setPeriod(parentRange)
  }, [parentRange?.start, parentRange?.end])

  const activeRange = period
  const rows = React.useMemo(
    () =>
      requests.filter(
        (q) =>
          q.status === 'Entregue' &&
          q.destination === 'Projeto' &&
          !q.list_removed &&
          within(q.closed_at || q.created_at, activeRange),
      ),
    [requests, activeRange],
  )
  const cents = (q) => q.items.reduce((v, i) => v + i.qty * Math.round(Number(i.price) * 100), 0)

  const byProject = groupedEntries(rows, (q) => q.project, cents)
  const byRegion = groupedEntries(rows, (q) => regionOf(q.state), cents)

  const consolidatedPeriodItems = React.useMemo(() => aggregateDeliveredItems(rows), [rows])

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
    return aggregateDeliveredItems(matchingRequests)
  }, [rows, selected])

  const detailTotalCents = detailItems.reduce((s, x) => s + x.cents, 0)

  function handleExportPeriod() {
    const bytes = buildDeliveredPeriodBytes(consolidatedPeriodItems, activeRange)
    triggerXlsxDownload(bytes, `Itens_Enviados_Consolidado_SSMA_${today()}.xlsx`)
  }

  return (
    <Panel
      title="Valor entregue por projeto e região"
      className="epi-cost-panel"
      action={
        <div className="epi-cost-toolbar">
          <DateRange value={period} onChange={setPeriod} compact />
          <button
            type="button"
            className="btn-green btn-compact"
            onClick={handleExportPeriod}
            disabled={!consolidatedPeriodItems.length}
            title="Exportar de forma consolidada todos os itens enviados no período selecionado"
          >
            <FileSpreadsheet size={15} aria-hidden="true" />
            <Download size={14} aria-hidden="true" /> Exportar itens enviados (.xlsx)
          </button>
        </div>
      }
    >
      <p className="epi-click-hint" style={{ margin: '0 0 10px' }}>
        Clique em um projeto ou região para ver os materiais enviados · Utilize as datas acima para filtrar e exportar por período.
      </p>

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
    db.rpc('ssma_epi_stock_costs').then(({ data: resData, error }) => {
      if (active) {
        setFailed(Boolean(error))
        setCosts(resData || [])
      }
    })
    return () => {
      active = false
    }
  }, [db, retry, data.requests])

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

  const macroRegionsByRegionId = new Map()
  for (const r of data.regions || []) {
    const mr = regionOf(r.state)
    if (mr) macroRegionsByRegionId.set(r.id, new Set([mr]))
  }
  for (const a of data.assignments || []) {
    if (a.active === false) continue
    const mr = regionOf(a.state)
    if (mr) {
      if (!macroRegionsByRegionId.has(a.region_id)) macroRegionsByRegionId.set(a.region_id, new Set())
      macroRegionsByRegionId.get(a.region_id).add(mr)
    }
  }
  for (const q of data.requests || []) {
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
    const linkedRegions = macroRegionsByRegionId.get(m.region_id)
    if (linkedRegions?.size) {
      for (const mr of linkedRegions) g.regions.add(mr)
    } else if (regObj?.state && regionOf(regObj.state)) {
      g.regions.add(regionOf(regObj.state))
    } else if (regObj) {
      g.regions.add(regionLabel(regObj))
    }
    groups.set(key, g)
  }

  const groupedList = [...groups.values()]
  const totalItemsQty = groupedList.reduce((s, g) => s + Number(g.qty || 0), 0)
  const totalStockCents = groupedList.reduce((s, g) => s + Number(g.cents || 0), 0)

  const genericsByCa = new Map()
  for (const g of groupedList) {
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
    const stockExportRows = groupedList.map((g) => ({
      material: [...g.names].join(' / '),
      ca: g.ca || 'Sem CA',
      generics: [...g.aliases].join(', ') || '—',
      region: [...g.regions].join(', ') || 'Todas',
      qty: g.qty,
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
        <div className="epi-consolidated-totals" role="region" aria-label="Totais do estoque consolidado">
          <div className="epi-consolidated-stat tone-green">
            <Layers size={18} aria-hidden="true" />
            <div>
              <small>Número total dos itens</small>
              <strong>{totalItemsQty.toLocaleString('pt-BR')}</strong>
            </div>
          </div>
          <div className="epi-consolidated-stat tone-blue">
            <Boxes size={18} aria-hidden="true" />
            <div>
              <small>Materiais / CAs consolidados</small>
              <strong>{groupedList.length.toLocaleString('pt-BR')}</strong>
            </div>
          </div>
          <div className="epi-consolidated-stat tone-neutral">
            <Wallet size={18} aria-hidden="true" />
            <div>
              <small>Valor total em estoque</small>
              <strong>{money(totalStockCents / 100)}</strong>
            </div>
          </div>
        </div>

        <Table
          headers={[
            'Material',
            'CA principal',
            'CAs genéricos',
            'Região',
            'Quantidade',
            'Valor médio unitário',
            'Valor total em estoque',
          ]}
          rows={[
            ...groupedList.map((g) => [
              <strong className="material-strong">{[...g.names].join(' / ')}</strong>,
              <span className="ca-pill">{g.ca || 'Sem CA'}</span>,
              [...g.aliases].join(', ') || '—',
              [...g.regions].join(', ') || '—',
              <span className="num-cell">{g.qty.toLocaleString('pt-BR')}</span>,
              <span className="num-cell">{g.qty ? money(g.cents / g.qty / 100) : '—'}</span>,
              <span className={g.cents > 0 ? 'money-strong' : 'money-muted'}>{money(g.cents / 100)}</span>,
            ]),
            ...(groupedList.length > 0
              ? [
                  [
                    <strong className="epi-consolidated-total-label">Total geral dos itens</strong>,
                    '',
                    '',
                    `${groupedList.length} material(is)`,
                    <strong className="num-cell epi-consolidated-total-num">{totalItemsQty.toLocaleString('pt-BR')}</strong>,
                    '—',
                    <strong className="money-strong epi-consolidated-total-num">{money(totalStockCents / 100)}</strong>,
                  ],
                ]
              : []),
          ]}
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
