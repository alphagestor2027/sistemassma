import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Hand,
  ShieldAlert,
  Clock3,
  Boxes,
  TrendingUp,
  ArrowUpRight,
  ShoppingCart,
  CircleCheck,
  ShieldCheck,
  FileCheck2,
  Wallet,
  Truck,
  MapPin,
  RefreshCw,
  Search,
  X,
} from 'lucide-react'
import { Skeleton } from './Skeleton'
import { Panel, Field, Select, Table } from './EpiShared'
import { available, money, regionOf, stockAreas, variant } from './epiData'
import { dateLabel, today } from './data'
import { recentPeriod } from './reportFilters'
import './epi.css'
import './stock-indicators.css'

const REGION_LIST = ['Norte', 'Nordeste', 'Centro-Oeste', 'Sudeste', 'Sul']

/* Mapa vetorial estilizado das 5 macrorregiões do Brasil (IBGE) */
const BRAZIL_REGIONS = [
  {
    name: 'Norte',
    code: 'N',
    color: '#0ea5e9',
    labelX: 165,
    labelY: 118,
    d: 'M 52 96 L 94 56 L 150 42 L 198 52 L 242 40 L 268 74 L 254 128 L 246 168 L 210 176 L 166 166 L 122 174 L 84 156 L 46 132 Z',
  },
  {
    name: 'Nordeste',
    code: 'NE',
    color: '#f59e0b',
    labelX: 326,
    labelY: 152,
    d: 'M 268 74 L 318 88 L 372 114 L 392 152 L 368 202 L 336 232 L 288 228 L 266 196 L 246 168 L 254 128 Z',
  },
  {
    name: 'Centro-Oeste',
    code: 'CO',
    color: '#d11f35',
    labelX: 208,
    labelY: 234,
    d: 'M 122 174 L 166 166 L 210 176 L 246 168 L 266 196 L 264 252 L 222 292 L 176 286 L 146 244 L 128 206 Z',
  },
  {
    name: 'Sudeste',
    code: 'SE',
    color: '#16a34a',
    labelX: 296,
    labelY: 276,
    d: 'M 266 196 L 288 228 L 336 232 L 348 268 L 318 308 L 264 316 L 236 298 L 222 292 L 264 252 Z',
  },
  {
    name: 'Sul',
    code: 'S',
    color: '#6366f1',
    labelX: 244,
    labelY: 356,
    d: 'M 222 292 L 236 298 L 264 316 L 282 352 L 248 402 L 206 382 L 214 334 Z',
  },
]

function toLocalDay(ts) {
  if (!ts) return ''
  const str = String(ts)
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str
  return new Date(str).toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' })
}

function inDateRange(ts, range) {
  if (!range.start && !range.end) return true
  const day = toLocalDay(ts)
  if (!day) return false
  return (!range.start || day >= range.start) && (!range.end || day <= range.end)
}

function resolveRegion(uf) {
  return regionOf(String(uf || '').trim().toUpperCase()) || 'Sem região'
}

export default function StockIndicators({ db, profile, employees = [], initialDays = 30 }) {
  const [raw, setRaw] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [tech, setTech] = useState('')
  const [region, setRegion] = useState('')
  const [uf, setUf] = useState('')
  const [periodChoice, setPeriodChoice] = useState(String(initialDays || 30))
  const [custom, setCustom] = useState(() => recentPeriod(initialDays || 30, today()))
  const [gloveFilter, setGloveFilter] = useState('all')
  const [gloveSearch, setGloveSearch] = useState('')
  const [hoveredRegion, setHoveredRegion] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const { data, error: rpcErr } = await db.rpc('ssma_epi_indicators', {
        p: tech ? { technician: tech } : {},
      })
      if (!rpcErr && data) {
        setRaw(data)
        setLoading(false)
        return
      }
      // Fallback caso a função nova ainda não tenha sido aplicada no banco Supabase
      const [wsRes, shipRes, techGlovesRes] = await Promise.all([
        db.rpc('ssma_epi_workspace'),
        db.rpc('ssma_epi_logistics', { action: 'shipments', p: {} }).catch(() => ({ data: { rows: [] } })),
        db.rpc('ssma_epi_technician_gloves').catch(() => ({ data: [] })),
      ])
      if (wsRes.error) throw wsRes.error
      const ws = wsRes.data || { regions: [], materials: [], requests: [], movements: [] }
      const empById = new Map(employees.map((e) => [e.id, e]))
      const fallbackGloves = Array.isArray(techGlovesRes.data) && techGlovesRes.data.length > 0
        ? techGlovesRes.data.map((g) => {
            const matchEmp = employees.find((e) => e.title === g.employee)
            return {
              ...g,
              project: g.project || matchEmp?.unit || '—',
            }
          })
        : (ws.requests || [])
            .filter((q) => q.status === 'Entregue')
            .flatMap((q) => {
              const emp = empById.get(q.employee_id)
              if (emp && emp.status === 'Inativo') return []
              return (q.items || [])
                .filter((it) => it.delivered_glove || (ws.materials || []).some((m) => m.id === it.material_id && m.insulating_glove))
                .map((it) => ({
                  employee_id: q.employee_id,
                  employee: emp?.title || q.employee,
                  project: emp?.unit || q.project || '—',
                  state: emp?.employee_state || q.state || '',
                  region_id: q.region_id,
                  material: variant(it),
                  ca: it.ca,
                  qty: Number(it.qty || 0),
                  due: it.glove_due || null,
                  rejected: false,
                  delivered_at: q.closed_at,
                }))
            })

      setRaw({
        technicians: [],
        regions: ws.regions || [],
        materials: (ws.materials || []).map((m) => {
          const r = (ws.regions || []).find((x) => x.id === m.region_id)
          return {
            ...m,
            unit_name: r?.distribution_unit || r?.name || 'Estoque',
            unit_state: r?.state || '',
          }
        }),
        gloves_delivered: fallbackGloves,
        movements: (ws.movements || []).map((v) => {
          const q = (ws.requests || []).find((x) => x.id === v.request_id)
          const r = (ws.regions || []).find((x) => x.id === v.region_id)
          return {
            ...v,
            state: q?.state || r?.state || '',
            project: q?.project || '',
            destination: q?.destination || '',
          }
        }),
        requests: (ws.requests || []).map((q) => ({
          ...q,
          sheet_signed: Boolean(q.sheet_signed),
          total_cents: (q.items || []).reduce(
            (s, i) => s + Number(i.qty || 0) * Math.round(Number(i.price || 0) * 100),
            0,
          ),
        })),
        sheets: ws.sheets || [],
        shipments: shipRes?.data?.rows || [],
      })
    } catch (err) {
      setError(err.message || 'Não foi possível carregar os indicadores de estoque.')
    } finally {
      setLoading(false)
    }
  }, [db, tech, employees])

  useEffect(() => {
    load()
  }, [load])

  const range = useMemo(() => {
    if (periodChoice === 'all') return { start: '', end: '' }
    if (periodChoice === 'custom') return custom
    return recentPeriod(Number(periodChoice), today())
  }, [periodChoice, custom])

  const validRange =
    periodChoice === 'all' ||
    (/^\d{4}-\d{2}-\d{2}$/.test(range.start) && /^\d{4}-\d{2}-\d{2}$/.test(range.end) && range.start <= range.end)

  const stateOptions = useMemo(() => {
    const base = region ? (stockAreas[region] || '').split(' ').filter(Boolean) : Object.values(stockAreas).join(' ').split(' ')
    if (profile?.is_master) return base.sort()
    const cov = profile?.coverage || []
    return cov.length ? base.filter((s) => cov.includes(s)).sort() : base.sort()
  }, [region, profile])

  const matchesLocationFilter = useCallback(
    (itemState, regionId) => {
      const st = String(itemState || '').trim().toUpperCase()
      if (!st && regionId && raw?.regions) {
        const regObj = raw.regions.find((r) => r.id === regionId)
        if (regObj?.state) {
          const fallbackSt = regObj.state.trim().toUpperCase()
          if (uf && fallbackSt !== uf) return false
          if (region && resolveRegion(fallbackSt) !== region) return false
          return true
        }
      }
      if (uf && st !== uf) return false
      if (region && resolveRegion(st) !== region) return false
      return true
    },
    [uf, region, raw],
  )

  const computed = useMemo(() => {
    if (!raw || !validRange) return null
    const nowDay = today()
    const regionMap = new Map((raw.regions || []).map((r) => [r.id, r]))

    // Materiais filtrados por localização
    const materials = (raw.materials || []).filter((m) => {
      const st = m.unit_state || regionMap.get(m.region_id)?.state || ''
      if (!st && (region || uf)) {
        // Estoque individual de técnico: aceita se o técnico atende a UF/região
        return !uf && !region
      }
      return matchesLocationFilter(st, m.region_id)
    })

    // Status de reposição de cada material
    const replenishmentOf = (m) => {
      const avail = available(m, nowDay)
      const min = Number(m.minimum || 0)
      if (avail < min) return 'Comprar'
      const limit = min > 0 ? min * 1.5 : 10
      if (avail > limit) return 'Acima'
      return 'Ideal'
    }

    let buyCount = 0
    let idealCount = 0
    let aboveCount = 0
    let totalPurchaseOrderCents = 0
    let totalPurchaseUnits = 0
    let totalAvailableUnits = 0
    const purchaseItems = []

    for (const m of materials) {
      const avail = Math.max(0, available(m, nowDay))
      totalAvailableUnits += avail
      const min = Number(m.minimum || 0)
      const rep = replenishmentOf(m)
      if (rep === 'Comprar') {
        buyCount++
        const missing = Math.max(0, min - avail)
        const lineCents = missing * Math.round(Number(m.price || 0) * 100)
        totalPurchaseUnits += missing
        totalPurchaseOrderCents += lineCents
        purchaseItems.push({
          ...m,
          avail,
          missing,
          lineCents,
        })
      } else if (rep === 'Ideal') {
        idealCount++
      } else {
        aboveCount++
      }
    }
    const doNotBuyCount = idealCount + aboveCount
    const currentStockCents = materials.reduce(
      (s, m) => s + Number(m.qty || 0) * Math.round(Number(m.price || 0) * 100),
      0,
    )

    // Luvas Isolantes em Estoque e com Colaboradores
    const stockGloveItems = materials.filter((m) => m.insulating_glove)
    const glovesInStockQty = stockGloveItems.reduce((s, m) => s + Number(m.qty || 0), 0)
    const glovesInStockAvail = stockGloveItems.reduce((s, m) => s + Math.max(0, available(m, nowDay)), 0)

    let stockExpiredGloves = 0
    let stockSoonGloves = 0
    for (const m of stockGloveItems) {
      const q = Number(m.qty || 0)
      if (q <= 0) continue
      const due = m.glove_start
        ? (() => {
            const d = new Date(m.glove_start + 'T12:00:00Z')
            d.setUTCDate(d.getUTCDate() + 365)
            return d.toISOString().slice(0, 10)
          })()
        : m.expiry || null
      if (due) {
        const diffDays = Math.round((Date.parse(due) - Date.parse(nowDay)) / 86400000)
        if (diffDays < 0) stockExpiredGloves += q
        else if (diffDays <= 30) stockSoonGloves += q
      }
    }

    const deliveredGloves = (raw.gloves_delivered || [])
      .filter((g) => matchesLocationFilter(g.state, g.region_id))
      .map((g) => {
        const diffDays = g.due ? Math.round((Date.parse(g.due) - Date.parse(nowDay)) / 86400000) : null
        const status = g.rejected || (diffDays !== null && diffDays < 0)
          ? 'expired'
          : diffDays !== null && diffDays <= 30
            ? 'soon'
            : 'ok'
        return {
          ...g,
          regionName: resolveRegion(g.state),
          diffDays,
          status,
        }
      })

    const glovesWithEmployees = deliveredGloves.reduce((s, g) => s + Number(g.qty || 0), 0)
    const expiredWithEmployees = deliveredGloves
      .filter((g) => g.status === 'expired')
      .reduce((s, g) => s + Number(g.qty || 0), 0)
    const soonWithEmployees = deliveredGloves
      .filter((g) => g.status === 'soon')
      .reduce((s, g) => s + Number(g.qty || 0), 0)

    const totalGlovesExpired = expiredWithEmployees + stockExpiredGloves
    const totalGlovesSoon30 = soonWithEmployees + stockSoonGloves

    // Movimentações no período (Entradas em valor sincronizadas)
    const movements = (raw.movements || []).filter(
      (v) => inDateRange(v.created_at, range) && matchesLocationFilter(v.state, v.region_id),
    )
    let grossEntryCents = 0
    let entryUnits = 0
    let adjustOutCents = 0
    for (const v of movements) {
      const cents = Number(v.qty || 0) * Math.round(Number(v.price || 0) * 100)
      if (v.kind === 'Entrada' || v.kind === 'Ajuste de entrada') {
        grossEntryCents += cents
        if (v.kind === 'Entrada') entryUnits += Number(v.qty || 0)
      } else if (v.kind === 'Ajuste de saída') {
        adjustOutCents += cents
      }
    }
    const netEntryCents = Math.max(0, grossEntryCents - adjustOutCents)

    // Solicitações entregues no período -> Valor transferido para projetos solicitantes + Fichas Assinadas
    const deliveredRequests = (raw.requests || []).filter(
      (q) => q.status === 'Entregue' && inDateRange(q.closed_at || q.created_at, range) && matchesLocationFilter(q.state, q.region_id),
    )
    const projectTransferRequests = deliveredRequests.filter((q) => !q.destination || q.destination === 'Projeto')
    const transferredToProjectsCents = projectTransferRequests.reduce(
      (s, q) => s + Number(q.total_cents || 0),
      0,
    )

    // Contagem unificada de fichas emitidas válidas (SOMENTE marcadas com Assinada)
    const sheetKeysSigned = new Set()
    const sheetKeysPending = new Set()
    for (const q of deliveredRequests) {
      if (q.sheet_signed) sheetKeysSigned.add(q.id)
      else sheetKeysPending.add(q.id)
    }
    for (const s of raw.sheets || []) {
      if (!inDateRange(s.issued_at, range) || !matchesLocationFilter(s.state, null)) continue
      const key = s.request_id || s.id
      if (s.signed) {
        sheetKeysSigned.add(key)
        sheetKeysPending.delete(key)
      } else if (!sheetKeysSigned.has(key)) {
        sheetKeysPending.add(key)
      }
    }

    // Correios no período
    const shipments = (raw.shipments || []).filter(
      (h) => inDateRange(h.sent, range) && matchesLocationFilter(h.state, h.unit_id),
    )
    const totalPostalCents = shipments.reduce((s, h) => s + Math.round(Number(h.cost || 0) * 100), 0)

    // Consolidação por Região (para o Mapa Interativo e Gestão de Correios)
    const byRegion = Object.fromEntries(
      REGION_LIST.map((r) => [
        r,
        {
          region: r,
          ufs: (stockAreas[r] || '').split(' ').filter(Boolean),
          projectCents: 0,
          glovesQty: 0,
          glovesAlert: 0,
          postalQty: 0,
          postalCents: 0,
          signedSheets: 0,
        },
      ]),
    )

    // Popula métricas regionais sem o filtro de região para que o Mapa mostre o panorama completo e permita clicar!
    const allDeliveredPeriod = (raw.requests || []).filter(
      (q) => q.status === 'Entregue' && inDateRange(q.closed_at || q.created_at, range),
    )
    for (const q of allDeliveredPeriod) {
      const rName = resolveRegion(q.state)
      if (!byRegion[rName]) continue
      if (!q.destination || q.destination === 'Projeto') {
        byRegion[rName].projectCents += Number(q.total_cents || 0)
      }
      if (q.sheet_signed) byRegion[rName].signedSheets += 1
    }
    for (const g of raw.gloves_delivered || []) {
      const rName = resolveRegion(g.state)
      if (!byRegion[rName]) continue
      byRegion[rName].glovesQty += Number(g.qty || 0)
      const diff = g.due ? Math.round((Date.parse(g.due) - Date.parse(nowDay)) / 86400000) : null
      if (g.rejected || (diff !== null && diff <= 30)) byRegion[rName].glovesAlert += Number(g.qty || 0)
    }
    for (const h of (raw.shipments || []).filter((x) => inDateRange(x.sent, range))) {
      const rName = resolveRegion(h.state)
      if (!byRegion[rName]) continue
      byRegion[rName].postalQty += 1
      byRegion[rName].postalCents += Math.round(Number(h.cost || 0) * 100)
    }

    // Agrupamento de Correios por Modalidade / Faixa de Valor
    const postalByModeMap = new Map()
    for (const h of shipments) {
      const key = h.mode || 'Padrão'
      const cur = postalByModeMap.get(key) || { mode: key, qty: 0, cents: 0 }
      cur.qty += 1
      cur.cents += Math.round(Number(h.cost || 0) * 100)
      postalByModeMap.set(key, cur)
    }
    const postalByMode = [...postalByModeMap.values()].sort((a, b) => b.cents - a.cents)

    return {
      materialsCount: materials.length,
      totalAvailableUnits,
      buyCount,
      idealCount,
      aboveCount,
      doNotBuyCount,
      totalPurchaseOrderCents,
      totalPurchaseUnits,
      purchaseItems: purchaseItems.sort((a, b) => b.lineCents - a.lineCents),
      currentStockCents,
      netEntryCents,
      entryUnits,
      transferredToProjectsCents,
      projectTransferCount: projectTransferRequests.length,
      signedSheetsCount: sheetKeysSigned.size,
      pendingSheetsCount: sheetKeysPending.size,
      glovesInStockQty,
      glovesInStockAvail,
      glovesWithEmployees,
      totalGlovesExpired,
      totalGlovesSoon30,
      stockExpiredGloves,
      stockSoonGloves,
      deliveredGloves,
      shipmentsCount: shipments.length,
      totalPostalCents,
      postalByMode,
      byRegion,
    }
  }, [raw, validRange, range, region, uf, matchesLocationFilter])

  const filteredGloveRows = useMemo(() => {
    if (!computed) return []
    const q = gloveSearch.trim().toLocaleLowerCase('pt-BR')
    return computed.deliveredGloves.filter((g) => {
      if (gloveFilter === 'expired' && g.status !== 'expired') return false
      if (gloveFilter === 'soon' && g.status !== 'soon') return false
      if (gloveFilter === 'ok' && g.status !== 'ok') return false
      if (q && ![g.employee, g.project, g.regionName, g.state, g.material, g.ca].join(' ').toLocaleLowerCase('pt-BR').includes(q)) {
        return false
      }
      return true
    })
  }, [computed, gloveFilter, gloveSearch])

  if (loading && !raw) {
    return <Skeleton layout="dashboard" label="Carregando indicadores de estoque…" />
  }

  if (error) {
    return (
      <div className="notice error" role="alert">
        {error}
        <button className="secondary" onClick={load}>Tentar novamente</button>
      </div>
    )
  }

  const maxFinancialBar = Math.max(
    100,
    computed?.netEntryCents || 0,
    computed?.transferredToProjectsCents || 0,
    computed?.currentStockCents || 0,
    computed?.totalPurchaseOrderCents || 0,
  )

  const totalItemsForDonut = Math.max(1, (computed?.buyCount || 0) + (computed?.idealCount || 0) + (computed?.aboveCount || 0))
  const buyDeg = Math.round(((computed?.buyCount || 0) / totalItemsForDonut) * 360)
  const idealDeg = Math.round(((computed?.idealCount || 0) / totalItemsForDonut) * 360)

  const activeMapRegion = hoveredRegion || region
  const maxRegionActivity = Math.max(
    1,
    ...REGION_LIST.map((r) => {
      const d = computed?.byRegion?.[r]
      return (d?.projectCents || 0) / 100 + (d?.postalCents || 0) / 100 + (d?.glovesQty || 0) * 50
    }),
  )

  return (
    <div className="epi stock-ind">
      {/* Barra Global de Filtros */}
      <Panel
        title="Filtros e Escopo dos Indicadores"
        action={
          <div className="button-group">
            {(region || uf || tech || periodChoice !== String(initialDays || 30)) && (
              <button
                type="button"
                className="secondary btn-compact"
                onClick={() => {
                  setRegion('')
                  setUf('')
                  setTech('')
                  setPeriodChoice(String(initialDays || 30))
                }}
              >
                <X size={14} aria-hidden="true" /> Limpar filtros
              </button>
            )}
            <button type="button" className="primary btn-compact" onClick={load}>
              <RefreshCw size={15} aria-hidden="true" /> Atualizar indicadores
            </button>
          </div>
        }
      >
        <div className="epi-filters stock-ind-filters">
          {profile?.is_master && (raw?.technicians?.length || 0) > 0 && (
            <Select
              label="Técnico / responsável"
              placeholder="Todos os responsáveis"
              value={tech}
              options={raw.technicians.map((t) => [t.id, t.name])}
              onChange={(e) => setTech(e.target.value)}
            />
          )}
          <Select
            label="Região"
            placeholder="Todas as regiões"
            value={region}
            options={REGION_LIST}
            onChange={(e) => {
              setRegion(e.target.value)
              setUf('')
            }}
          />
          <Select
            label="Estado (UF)"
            placeholder="Todos os estados"
            value={uf}
            options={stateOptions}
            onChange={(e) => setUf(e.target.value)}
          />
          <Field label="Período">
            <select
              aria-label="Período dos indicadores de estoque"
              value={periodChoice}
              onChange={(e) => {
                if (e.target.value === 'custom' && range.start && range.end) setCustom(range)
                setPeriodChoice(e.target.value)
              }}
            >
              <option value="7">Últimos 7 dias</option>
              <option value="30">Últimos 30 dias</option>
              <option value="90">Últimos 90 dias</option>
              <option value="365">Últimos 365 dias</option>
              <option value="all">Todo o histórico</option>
              <option value="custom">Personalizado</option>
            </select>
          </Field>
          {periodChoice === 'custom' && (
            <>
              <Field
                label="Data inicial"
                type="date"
                value={custom.start}
                max={custom.end || undefined}
                onChange={(e) => setCustom({ ...custom, start: e.target.value })}
              />
              <Field
                label="Data final"
                type="date"
                value={custom.end}
                min={custom.start || undefined}
                onChange={(e) => setCustom({ ...custom, end: e.target.value })}
              />
            </>
          )}
        </div>
        {!validRange ? (
          <p role="alert" className="form-error">
            Informe uma data inicial menor ou igual à data final.
          </p>
        ) : (
          <p className="stock-ind-period-caption">
            {periodChoice === 'all'
              ? 'Exibindo acumulado completo de todo o período registrado.'
              : `Movimentações, entregas, fichas e envios de ${dateLabel(range.start)} até ${dateLabel(range.end)} · Posição física atual do estoque.`}
          </p>
        )}
      </Panel>

      {computed && (
        <>
          {/* MAPA INTERATIVO POR REGIÃO */}
          <Panel
            title="Mapa Operacional por Região"
            icon={<MapPin size={20} aria-hidden="true" />}
            action={
              region ? (
                <button type="button" className="btn-outline-red" onClick={() => { setRegion(''); setUf('') }}>
                  Região filtrada: {region} · Ver Brasil inteiro
                </button>
              ) : (
                <span className="stock-ind-hint">Clique em uma região no mapa para filtrar todos os indicadores</span>
              )
            }
          >
            <div className="stock-ind-map-grid">
              <div className="stock-ind-map-box">
                <svg
                  viewBox="0 0 430 430"
                  className="brazil-map-svg"
                  role="img"
                  aria-label="Mapa interativo de indicadores por macrorregião do Brasil"
                >
                  {BRAZIL_REGIONS.map((r) => {
                    const stats = computed.byRegion[r.name] || {}
                    const score = (stats.projectCents || 0) / 100 + (stats.postalCents || 0) / 100 + (stats.glovesQty || 0) * 50
                    const intensity = 0.22 + 0.65 * Math.min(1, score / maxRegionActivity)
                    const isSelected = region === r.name
                    const isHovered = hoveredRegion === r.name
                    const dimmed = Boolean(region && !isSelected)
                    return (
                      <g
                        key={r.name}
                        className={'map-region-group' + (isSelected ? ' selected' : '') + (dimmed ? ' dimmed' : '')}
                        onClick={() => {
                          setRegion(region === r.name ? '' : r.name)
                          setUf('')
                        }}
                        onMouseEnter={() => setHoveredRegion(r.name)}
                        onMouseLeave={() => setHoveredRegion('')}
                        role="button"
                        tabIndex={0}
                        aria-label={`Filtrar região ${r.name}`}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            setRegion(region === r.name ? '' : r.name)
                            setUf('')
                          }
                        }}
                      >
                        <path
                          d={r.d}
                          fill={r.color}
                          fillOpacity={isSelected || isHovered ? 0.92 : dimmed ? 0.18 : intensity}
                          stroke="#ffffff"
                          strokeWidth={isSelected ? 3.5 : 2}
                          strokeLinejoin="round"
                        />
                        <circle cx={r.labelX} cy={r.labelY} r="17" className="map-region-badge" />
                        <text x={r.labelX} y={r.labelY + 4} textAnchor="middle" className="map-region-code">
                          {r.code}
                        </text>
                      </g>
                    )
                  })}
                </svg>
                {activeMapRegion && computed.byRegion[activeMapRegion] && (
                  <div className="map-floating-card">
                    <strong>{activeMapRegion}</strong>
                    <span>Projetos: <b>{money(computed.byRegion[activeMapRegion].projectCents / 100)}</b></span>
                    <span>Luvas c/ colab.: <b>{computed.byRegion[activeMapRegion].glovesQty}</b></span>
                    <span>Correios: <b>{computed.byRegion[activeMapRegion].postalQty} env. ({money(computed.byRegion[activeMapRegion].postalCents / 100)})</b></span>
                  </div>
                )}
              </div>

              <div className="stock-ind-region-cards">
                {BRAZIL_REGIONS.map((r) => {
                  const st = computed.byRegion[r.name]
                  const active = region === r.name
                  return (
                    <button
                      type="button"
                      key={r.name}
                      className={'region-stat-row' + (active ? ' active' : '')}
                      onClick={() => {
                        setRegion(active ? '' : r.name)
                        setUf('')
                      }}
                    >
                      <span className="region-dot" style={{ background: r.color }} aria-hidden="true" />
                      <div className="region-stat-main">
                        <strong>{r.name}</strong>
                        <small>{st.ufs.join(' · ')}</small>
                      </div>
                      <div className="region-stat-metrics">
                        <div>
                          <small>Transferido Projetos</small>
                          <strong>{money(st.projectCents / 100)}</strong>
                        </div>
                        <div>
                          <small>Luvas Ativas</small>
                          <strong>
                            {st.glovesQty}
                            {st.glovesAlert > 0 && <em className="region-alert-pill">{st.glovesAlert} alerta</em>}
                          </strong>
                        </div>
                        <div>
                          <small>Correios</small>
                          <strong>{st.postalQty} · {money(st.postalCents / 100)}</strong>
                        </div>
                        <div>
                          <small>Fichas Assinadas</small>
                          <strong>{st.signedSheets}</strong>
                        </div>
                      </div>
                    </button>
                  )
                })}
              </div>
            </div>
          </Panel>

          {/* 1. GESTÃO DE LUVAS ISOLANTES */}
          <Panel title="Gestão de Luvas Isolantes" icon={<Hand size={20} aria-hidden="true" />}>
            <div className="epi-indicators stock-ind-kpi-4">
              <div className="epi-indicator tone-blue">
                <span className="epi-indicator-icon"><Boxes size={22} aria-hidden="true" /></span>
                <div>
                  <span>Luvas Isolantes em Estoque</span>
                  <strong>{computed.glovesInStockQty}</strong>
                  <small className="kpi-sub">{computed.glovesInStockAvail} disponíveis p/ entrega</small>
                </div>
              </div>
              <div className="epi-indicator tone-green">
                <span className="epi-indicator-icon"><Hand size={22} aria-hidden="true" /></span>
                <div>
                  <span>Luvas com Colaboradores</span>
                  <strong>{computed.glovesWithEmployees}</strong>
                  <small className="kpi-sub">Em posse de colaboradores ativos</small>
                </div>
              </div>
              <div className="epi-indicator tone-red">
                <span className="epi-indicator-icon"><ShieldAlert size={22} aria-hidden="true" /></span>
                <div>
                  <span>Luvas Isolantes Vencidas</span>
                  <strong>{computed.totalGlovesExpired}</strong>
                  <small className="kpi-sub">
                    {computed.stockExpiredGloves > 0
                      ? `${computed.totalGlovesExpired - computed.stockExpiredGloves} c/ colab. · ${computed.stockExpiredGloves} no estoque`
                      : 'Exigem substituição imediata'}
                  </small>
                </div>
              </div>
              <div className="epi-indicator tone-amber">
                <span className="epi-indicator-icon"><Clock3 size={22} aria-hidden="true" /></span>
                <div>
                  <span>30 Dias Antes do Vencimento</span>
                  <strong>{computed.totalGlovesSoon30}</strong>
                  <small className="kpi-sub">Vencem nos próximos 30 dias</small>
                </div>
              </div>
            </div>

            <div className="stock-ind-subhead">
              <div>
                <h3>Região, Projeto e Colaboradores com Luvas Isolantes</h3>
                <p>Rastreabilidade nominal por região, unidade/projeto e prazo de ensaio dielétrico</p>
              </div>
              <div className="search-filter-pills" style={{ margin: 0 }}>
                {[
                  ['all', `Todas (${computed.deliveredGloves.length})`],
                  ['expired', `Vencidas (${computed.deliveredGloves.filter((g) => g.status === 'expired').length})`],
                  ['soon', `Até 30 dias (${computed.deliveredGloves.filter((g) => g.status === 'soon').length})`],
                  ['ok', `Em dia (${computed.deliveredGloves.filter((g) => g.status === 'ok').length})`],
                ].map(([key, label]) => (
                  <button
                    type="button"
                    key={key}
                    className={'pill-btn' + (gloveFilter === key ? ' active' : '')}
                    onClick={() => setGloveFilter(key)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div className="epi-filters">
              <Field
                label="Buscar por colaborador, projeto ou região"
                type="search"
                icon={<Search size={15} aria-hidden="true" />}
                placeholder="Digite o nome do colaborador, projeto ou UF…"
                value={gloveSearch}
                onChange={(e) => setGloveSearch(e.target.value)}
              />
            </div>

            <Table
              headers={['Região', 'UF', 'Projeto', 'Nome do colaborador', 'Luva Isolante / CA', 'Qtd.', 'Vencimento', 'Situação']}
              rows={filteredGloveRows.map((g) => [
                g.regionName,
                g.state ? <span className="uf-pill">{g.state}</span> : '—',
                <strong className="material-strong">{g.project || '—'}</strong>,
                <strong className="material-strong">{g.employee}</strong>,
                <span>{g.material}{g.ca ? ` · CA ${g.ca}` : ''}</span>,
                g.qty,
                g.due ? dateLabel(g.due) : 'Sem data',
                g.status === 'expired' ? (
                  <span className="badge red">Vencida · Substituir</span>
                ) : g.status === 'soon' ? (
                  <span className="badge amber-badge">Vence em {g.diffDays} dia(s)</span>
                ) : (
                  <span className="badge green">Em dia</span>
                ),
              ])}
              empty="Nenhuma luva isolante em posse de colaborador para os filtros selecionados."
            />
          </Panel>

          {/* 2. GESTÃO DE ESTOQUE */}
          <Panel title="Gestão de Estoque" icon={<Boxes size={20} aria-hidden="true" />}>
            <div className="stock-ind-kpi-8">
              <div className="epi-metric-card tone-neutral">
                <div className="metric-card-top">
                  <small>Quantidade de entrada em valor</small>
                  <TrendingUp size={17} className="metric-icon green-ic" aria-hidden="true" />
                </div>
                <strong>{money(computed.netEntryCents / 100)}</strong>
                <span className="kpi-sub">{computed.entryUnits} un. registradas na entrada</span>
              </div>

              <div className="epi-metric-card tone-rose">
                <div className="metric-card-top">
                  <small>Subtraído p/ projeto solicitante</small>
                  <ArrowUpRight size={17} className="metric-icon red-ic" aria-hidden="true" />
                </div>
                <strong>{money(computed.transferredToProjectsCents / 100)}</strong>
                <span className="kpi-sub">{computed.projectTransferCount} entrega(s) transferidas p/ projetos</span>
              </div>

              <div className="epi-metric-card tone-neutral">
                <div className="metric-card-top">
                  <small>Quantidade de itens</small>
                  <Boxes size={17} className="metric-icon blue-ic" aria-hidden="true" />
                </div>
                <strong>{computed.materialsCount}</strong>
                <span className="kpi-sub">{computed.totalAvailableUnits} un. físicas disponíveis</span>
              </div>

              <div className="epi-metric-card tone-rose">
                <div className="metric-card-top">
                  <small>Quantidade (Comprar)</small>
                  <ShoppingCart size={17} className="metric-icon red-ic" aria-hidden="true" />
                </div>
                <strong>{computed.buyCount}</strong>
                <span className="kpi-sub">{computed.totalPurchaseUnits} un. abaixo do mínimo</span>
              </div>

              <div className="epi-metric-card tone-green">
                <div className="metric-card-top">
                  <small>Quantidade (Ideal)</small>
                  <CircleCheck size={17} className="metric-icon green-ic" aria-hidden="true" />
                </div>
                <strong>{computed.idealCount}</strong>
                <span className="kpi-sub">Estoque dentro da faixa ideal</span>
              </div>

              <div className="epi-metric-card tone-neutral">
                <div className="metric-card-top">
                  <small>Quantidade (Não Comprar)</small>
                  <ShieldCheck size={17} className="metric-icon blue-ic" aria-hidden="true" />
                </div>
                <strong>{computed.doNotBuyCount}</strong>
                <span className="kpi-sub">{computed.idealCount} ideal · {computed.aboveCount} acima do mínimo</span>
              </div>

              <div className="epi-metric-card tone-green">
                <div className="metric-card-top">
                  <small>Fichas de EPI emitidas (Assinadas)</small>
                  <FileCheck2 size={17} className="metric-icon green-ic" aria-hidden="true" />
                </div>
                <strong>{computed.signedSheetsCount}</strong>
                <span className="kpi-sub">
                  {computed.pendingSheetsCount > 0
                    ? `${computed.pendingSheetsCount} entrega(s) aguardando assinatura`
                    : 'Somente fichas marcadas com Assinada'}
                </span>
              </div>

              <div className="epi-metric-card tone-amber-card">
                <div className="metric-card-top">
                  <small>Valor total de pedido p/ compra geral</small>
                  <Wallet size={17} className="metric-icon amber-ic" aria-hidden="true" />
                </div>
                <strong>{money(computed.totalPurchaseOrderCents / 100)}</strong>
                <span className="kpi-sub">Orçamento p/ recompor {computed.buyCount} item(ns)</span>
              </div>
            </div>

            {/* Gráficos de Gestão de Estoque */}
            <div className="stock-ind-charts-grid">
              <div className="stock-chart-box">
                <h3>Balanço Financeiro do Estoque (R$)</h3>
                <p>Comparativo entre entradas, transferências para projetos, saldo atual e necessidade de compra</p>
                <div className="fin-bars-list">
                  {[
                    ['Entrada líquida em valor', computed.netEntryCents, '#16a34a'],
                    ['Transferido p/ projetos solicitantes', computed.transferredToProjectsCents, '#d11f35'],
                    ['Saldo atual em estoque · SSMA', computed.currentStockCents, '#2563eb'],
                    ['Pedido geral para compra (reposição)', computed.totalPurchaseOrderCents, '#d97706'],
                  ].map(([label, cents, color]) => {
                    const pct = Math.max(2, Math.round((cents / maxFinancialBar) * 100))
                    return (
                      <div className="fin-bar-item" key={label}>
                        <div className="fin-bar-head">
                          <span>{label}</span>
                          <strong>{money(cents / 100)}</strong>
                        </div>
                        <div className="fin-bar-track">
                          <span style={{ width: (cents > 0 ? pct : 0) + '%', background: color }} />
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>

              <div className="stock-chart-box">
                <h3>Distribuição de Reposição dos Itens</h3>
                <p>Proporção entre itens para compra imediata e itens que não precisam de compra</p>
                <div className="stock-donut-wrap">
                  <div
                    className="stock-donut"
                    style={{
                      background:
                        computed.materialsCount === 0
                          ? '#e2e8f0'
                          : `conic-gradient(#dc2626 0deg ${buyDeg}deg, #16a34a ${buyDeg}deg ${buyDeg + idealDeg}deg, #2563eb ${buyDeg + idealDeg}deg 360deg)`,
                    }}
                  >
                    <div className="stock-donut-hole">
                      <strong>{computed.materialsCount}</strong>
                      <small>ITENS</small>
                    </div>
                  </div>
                  <div className="stock-donut-legend">
                    <div>
                      <span><i style={{ background: '#dc2626' }} /> Comprar</span>
                      <strong>{computed.buyCount}</strong>
                    </div>
                    <div>
                      <span><i style={{ background: '#16a34a' }} /> Ideal (Não comprar)</span>
                      <strong>{computed.idealCount}</strong>
                    </div>
                    <div>
                      <span><i style={{ background: '#2563eb' }} /> Acima (Não comprar)</span>
                      <strong>{computed.aboveCount}</strong>
                    </div>
                    <div className="donut-legend-total">
                      <span>Total Não Comprar</span>
                      <strong>{computed.doNotBuyCount}</strong>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {computed.purchaseItems.length > 0 && (
              <details className="stock-purchase-details">
                <summary>
                  Ver relação detalhada de itens para compra ({computed.purchaseItems.length} itens · {money(computed.totalPurchaseOrderCents / 100)})
                </summary>
                <Table
                  headers={['Material / Grade', 'CA', 'Unidade', 'Disponível', 'Mínimo', 'Qtd. a Comprar', 'Valor Unitário', 'Valor do Pedido']}
                  rows={computed.purchaseItems.map((m) => [
                    <strong className="material-strong">{variant(m)}</strong>,
                    m.no_ca ? 'Sem CA' : m.ca,
                    m.unit_name,
                    m.avail,
                    m.minimum,
                    <span className="badge red">{m.missing} un.</span>,
                    money(m.price),
                    <strong className="money-strong">{money(m.lineCents / 100)}</strong>,
                  ])}
                />
              </details>
            )}
          </Panel>

          {/* 3. GESTÃO DE CORREIOS */}
          <Panel title="Gestão de Correios" icon={<Truck size={20} aria-hidden="true" />}>
            <div className="epi-indicators stock-ind-kpi-3">
              <div className="epi-indicator tone-red">
                <span className="epi-indicator-icon"><Wallet size={22} aria-hidden="true" /></span>
                <div>
                  <span>Valor Total em Envios</span>
                  <strong>{money(computed.totalPostalCents / 100)}</strong>
                  <small className="kpi-sub">Despesa acumulada com postagens</small>
                </div>
              </div>
              <div className="epi-indicator tone-blue">
                <span className="epi-indicator-icon"><Truck size={22} aria-hidden="true" /></span>
                <div>
                  <span>Quantidade de Envios</span>
                  <strong>{computed.shipmentsCount}</strong>
                  <small className="kpi-sub">Remessas registradas no período</small>
                </div>
              </div>
              <div className="epi-indicator tone-green">
                <span className="epi-indicator-icon"><TrendingUp size={22} aria-hidden="true" /></span>
                <div>
                  <span>Valor Médio por Envio</span>
                  <strong>
                    {money(computed.shipmentsCount ? computed.totalPostalCents / computed.shipmentsCount / 100 : 0)}
                  </strong>
                  <small className="kpi-sub">Ticket médio das postagens</small>
                </div>
              </div>
            </div>

            <div className="epi-split stock-postal-split">
              <div className="stock-chart-box">
                <h3>Quantidade e Valor por Região</h3>
                <Table
                  headers={['Região', 'Quantidade de Envios', 'Valor em Envios', 'Participação']}
                  rows={REGION_LIST.filter((r) => !region || r === region).map((r) => {
                    const st = computed.byRegion[r]
                    const share = computed.totalPostalCents > 0
                      ? Math.round((st.postalCents / computed.totalPostalCents) * 100) + '%'
                      : '0%'
                    return [
                      <strong className="material-strong">{r}</strong>,
                      st.postalQty,
                      <strong className="money-strong">{money(st.postalCents / 100)}</strong>,
                      share,
                    ]
                  })}
                />
              </div>

              <div className="stock-chart-box">
                <h3>Quantidade por Valor e Modalidade</h3>
                <Table
                  headers={['Modalidade', 'Quantidade', 'Valor Médio', 'Valor Total']}
                  rows={computed.postalByMode.map((m) => [
                    <strong className="material-strong">{m.mode}</strong>,
                    m.qty,
                    money(m.cents / m.qty / 100),
                    <strong className="money-strong">{money(m.cents / 100)}</strong>,
                  ])}
                  empty="Nenhum envio pelos Correios registrado no período selecionado."
                />
              </div>
            </div>
          </Panel>
        </>
      )}
    </div>
  )
}
