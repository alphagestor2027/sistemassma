const dayMs = 86400000

export function recentPeriod(days, end) {
  const start = new Date(Date.parse(end + 'T00:00:00Z') - (days - 1) * dayMs)
  return { start: start.toISOString().slice(0, 10), end }
}

export function matchesLocation(states, regionStates, selectedState, coverage) {
  if (!regionStates && !selectedState) return true
  return (states?.length ? states : [null]).some((state) => {
    if (!state || state === 'Sem UF informada') return !regionStates && selectedState === 'Sem UF informada'
    return (
      (!regionStates || regionStates.includes(state)) &&
      (!selectedState || state === selectedState) &&
      (!coverage || coverage.includes(state))
    )
  })
}

// Group by day for short selections and by calendar months for longer periods.
export function trendBuckets(start, end) {
  const first = new Date(start + 'T00:00:00Z'),
    last = new Date(end + 'T00:00:00Z')
  const days = Math.round((last - first) / dayMs) + 1
  const months =
    (last.getUTCFullYear() - first.getUTCFullYear()) * 12 + last.getUTCMonth() - first.getUTCMonth() + 1
  const monthly = days > 31
  const step = monthly ? Math.ceil(months / 18) : 1
  const cursor = new Date(first)
  if (monthly) cursor.setUTCDate(1)
  const buckets = []
  while (cursor <= last) {
    const key = cursor.toISOString().slice(0, 10)
    const label = cursor.toLocaleDateString('pt-BR', {
      timeZone: 'UTC',
      ...(monthly ? { month: 'short', year: '2-digit' } : { day: '2-digit', month: '2-digit' }),
    })
    if (monthly) cursor.setUTCMonth(cursor.getUTCMonth() + step)
    else cursor.setUTCDate(cursor.getUTCDate() + 1)
    buckets.push({ start: key < start ? start : key, until: cursor.toISOString().slice(0, 10), label })
  }
  return buckets
}
