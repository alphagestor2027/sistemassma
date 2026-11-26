import { regionOf, states } from './epiData.js'

/**
 * Tabela oficial de faixas postais dos Correios (8 dígitos -> UF)
 * Permite identificar UF e Macrorregião instantaneamente (0ms), inclusive offline.
 */
const CEP_RANGES = [
  [1000000, 19999999, 'SP'],
  [20000000, 28999999, 'RJ'],
  [29000000, 29999999, 'ES'],
  [30000000, 39999999, 'MG'],
  [40000000, 48999999, 'BA'],
  [49000000, 49999999, 'SE'],
  [50000000, 56999999, 'PE'],
  [57000000, 57999999, 'AL'],
  [58000000, 58999999, 'PB'],
  [59000000, 59999999, 'RN'],
  [60000000, 63999999, 'CE'],
  [64000000, 64999999, 'PI'],
  [65000000, 65999999, 'MA'],
  [66000000, 68899999, 'PA'],
  [68900000, 68999999, 'AP'],
  [69000000, 69299999, 'AM'],
  [69300000, 69399999, 'RR'],
  [69400000, 69899999, 'AM'],
  [69900000, 69999999, 'AC'],
  [70000000, 72799999, 'DF'],
  [72800000, 72999999, 'GO'],
  [73000000, 73699999, 'DF'],
  [73700000, 76799999, 'GO'],
  [76800000, 76999999, 'RO'],
  [77000000, 77999999, 'TO'],
  [78000000, 78899999, 'MT'],
  [79000000, 79999999, 'MS'],
  [80000000, 87999999, 'PR'],
  [88000000, 89999999, 'SC'],
  [90000000, 99999999, 'RS'],
]

export function cleanCep(value) {
  return String(value || '').replace(/\D/g, '').slice(0, 8)
}

export function formatCep(value) {
  const digits = cleanCep(value)
  if (digits.length <= 5) return digits
  return digits.slice(0, 5) + '-' + digits.slice(5)
}

export function resolveCepLocation(cepInput) {
  const digits = cleanCep(cepInput)
  if (digits.length !== 8) return null
  const num = Number(digits)
  for (const [min, max, uf] of CEP_RANGES) {
    if (num >= min && num <= max) {
      return {
        cep: formatCep(digits),
        digits,
        uf,
        region: regionOf(uf),
      }
    }
  }
  return null
}

export async function lookupCepDetails(cepInput, signal) {
  const base = resolveCepLocation(cepInput)
  if (!base) return null
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 3500)
    if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true })
    const res = await fetch(`https://viacep.com.br/ws/${base.digits}/json/`, {
      signal: controller.signal,
    })
    clearTimeout(timer)
    if (!res.ok) return base
    const json = await res.json()
    if (json?.erro) return { ...base, notFound: true }
    const uf = states.includes(String(json.uf || '').toUpperCase())
      ? String(json.uf).toUpperCase()
      : base.uf
    return {
      ...base,
      uf,
      region: regionOf(uf) || base.region,
      city: json.localidade || '',
      neighborhood: json.bairro || '',
      street: json.logradouro || '',
    }
  } catch {
    return base
  }
}
