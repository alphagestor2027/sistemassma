export const topics={
  priorities:'Prioridades da semana',gloves:'Troca de luvas nos próximos 30 dias',orders:'Pedidos que posso atender',
  employees:'Pendências de cadastro e certificação',finance:'Comparar despesas dos projetos',stock:'Reposição de estoque',
  shipments:'Gastos com envios',module:'Resumo desta área'
}
export const portalHelp={
  solicitar:'Selecione seu nome no portal. Confira projeto e técnico, escolha as quantidades disponíveis e envie a solicitação. Guarde o código de rastreamento mostrado após o envio.',
  rastrear:'Em Acompanhar um pedido, informe o código recebido ou use a consulta pelo nome completo. O histórico mostra a etapa registrada pela equipe de SSMA.',
  cadastro:'Se seu nome estiver ausente ou os dados do projeto estiverem incorretos, peça a atualização do seu cadastro à equipe de SSMA.'
}
export const portalLabels={solicitar:'Como solicitar EPI?',rastrear:'Como rastrear meu pedido?',cadastro:'Como corrigir meu cadastro?'}
export function topicAllowed(profile,topic) {
  if(topic==='priorities'||topic==='module')return true
  if(profile.is_master)return true
  const grants=profile.permissions||[]
  const keys={gloves:['epi.estoque','epi.solicitacoes','epi.ficha','epi.ensaios'],orders:['epi.solicitacoes'],stock:['epi.estoque'],employees:['colaboradores'],finance:[],shipments:['epi.correios']}
  return (keys[topic]||[]).some(k=>grants.includes(k))
}
