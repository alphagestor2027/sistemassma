import { today } from './data.js'

export const states =
  'AC AL AP AM BA CE DF ES GO MA MT MS MG PA PB PR PE PI RJ RN RS RO RR SC SP SE TO'.split(' ')
export const money = (value) =>
  Number(value || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
export const stamp = (value) =>
  new Date(value).toLocaleString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    dateStyle: 'short',
    timeStyle: 'short',
  })
export const variant = (m) => [m.name, m.size && 'Tam. ' + m.size, m.color].filter(Boolean).join(' · ')
export const regionLabel = (r) => (r ? r.distribution_unit || [r.state, r.name, r.technician].join(' · ') : 'Sem unidade')
export const available = (m, date = today()) =>
  m.insulating_glove && (!m.glove_start || m.glove_start > date)
    ? 0
    : m.expiry && m.expiry < date
      ? 0
      : m.qty - m.reserved
export const nextStatus = {
  'Em uso': ['Em trânsito'],
  'Em trânsito': ['No laboratório'],
  'No laboratório': ['Em retorno', 'Reprovado'],
  'Em retorno': ['Em uso'],
  Reprovado: [],
}

export function forecast(material, rules, assignments, requests, horizon, date = today()) {
  const day = (d) => Date.parse(d + 'T00:00:00Z') / 86400000
  const start = day(date),
    end = start + horizon
  let demand = 0
  for (const rule of rules.filter((s) => s.material_id === material.id)) {
    const members = assignments.filter(
      (a) =>
        a.active !== false && a.region_id === material.region_id && a.job.trim().toLowerCase() === rule.job,
    )
    for (const member of members) {
      const orders = requests.filter(
        (q) =>
          q.employee_id === member.employee_id &&
          q.region_id === member.region_id &&
          q.items.some((i) => i.material_id === material.id),
      )
      const deliveries = orders
        .filter((q) => q.status === 'Entregue')
        .map((q) => day(new Date(q.closed_at).toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' })))
      const first = deliveries.length ? Math.max(start, Math.max(...deliveries) + rule.days) : start
      const cycles = first > end ? 0 : 1 + Math.floor((end - first) / rule.days)
      const pending = orders
        .filter((q) => q.status === 'Solicitado')
        .reduce((sum, q) => sum + q.items.find((i) => i.material_id === material.id).qty, 0)
      demand += Math.max(0, cycles * rule.qty - pending)
    }
  }
  return { demand, buy: Math.max(0, demand + material.minimum - available(material, date)) }
}

export function expenseGroups(requests) {
  const groups = new Map()
  for (const q of requests.filter((q) => q.status === 'Entregue'))
    for (const item of q.items) {
      const fields = [q.destination, q.project, q.state, q.center, q.contract, item.material_id]
      const key = JSON.stringify(fields)
      const row = groups.get(key) || {
        destination: q.destination,
        project: q.project,
        state: q.state,
        center: q.center,
        contract: q.contract,
        material: variant(item),
        qty: 0,
        cents: 0,
      }
      row.qty += item.qty
      row.cents += item.qty * Math.round(Number(item.price) * 100)
      groups.set(key, row)
    }
  return [...groups.values()]
}
export function after365(date) {
  if (!date) return ''
  const end = new Date(date + 'T12:00:00Z')
  end.setUTCDate(end.getUTCDate() + 365)
  return end.toISOString().slice(0, 10)
}

export const stockAreas = {
  'Centro-Oeste': 'DF GO MT MS',
  Nordeste: 'AL BA CE MA PB PE PI RN SE',
  Norte: 'AC AP AM PA RO RR TO',
  Sudeste: 'ES MG RJ SP',
  Sul: 'PR RS SC',
}

export function regionOf(uf) {
  return Object.keys(stockAreas).find((region) => stockAreas[region].split(' ').includes(uf)) || ''
}
