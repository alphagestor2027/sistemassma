export const epiSections = {
  Estoque: 'estoque',
  Solicitações: 'solicitacoes',
  Financeiro: 'financeiro',
  'Ficha digital': 'ficha',
  'Ensaios e retornos': 'ensaios',
  'Previsão de compras': 'compras',
  'Histórico de movimentações': 'historico',
}
export function permitted(profile, key) {
  if (!profile || profile.active === false) return false
  return profile.is_master === true || (profile.permissions || []).includes(key)
}
export function canOpen(profile, key) {
  return key === 'epis'
    ? Object.values(epiSections).some((s) => permitted(profile, 'epi.' + s))
    : permitted(profile, key)
}
