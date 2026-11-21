export const providers = [
  {id:'gemini',name:'Google Gemini',model:'gemini-3.1-flash-lite',key:'GEMINI_API_KEY',url:'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions'},
  {id:'groq',name:'Groq',model:'openai/gpt-oss-20b',key:'GROQ_API_KEY',url:'https://api.groq.com/openai/v1/chat/completions'},
  {id:'openrouter',name:'OpenRouter',model:'openrouter/free',key:'OPENROUTER_API_KEY',url:'https://openrouter.ai/api/v1/chat/completions'},
]
const errors={
  configuration:'Chave ausente no ambiente de produção.',credentials:'Credencial recusada. Confira a chave e suas permissões.',
  quota:'Cota ou limite de requisições atingido.',model:'Modelo indisponível para a conta.',
  upstream:'Serviço do provedor indisponível.',network:'Falha de conexão ou tempo de resposta excedido.',
  empty:'O provedor retornou uma resposta vazia.',request:'O provedor recusou o formato da consulta.',
  policy:'Resposta bloqueada pelo filtro de conteúdo do provedor.'
}
export async function attempt(provider,messages,{env=process.env,send=fetch}={}) {
  const begin=Date.now()
  let http=null,code='network',suffix='',wait=60,answer=''
  try {
    if (!env[provider.key]) code='configuration'
    else {
      const response=await send(provider.url,{method:'POST',headers:{Authorization:'Bearer '+env[provider.key],'Content-Type':'application/json'},
        body:JSON.stringify({model:provider.model,messages,max_tokens:1000}),signal:AbortSignal.timeout(11500)})
      http=response.status
      const payload=await response.json().catch(()=>({}))
      const upstream=String(payload.error?.code??payload.error?.status??'')
      if(/^[\w.-]{1,60}$/.test(upstream)) suffix=' Código do provedor '+upstream+'.'
      const trace=response.headers.get('x-request-id')
      if(trace&&/^[\w.-]{1,100}$/.test(trace)) suffix+=' Requisição '+trace+'.'
      const retry=Number(response.headers.get('retry-after'))
      if(retry>0) wait=Math.min(86400,Math.ceil(retry))
      const choice=payload.choices?.[0]
      if(choice?.finish_reason==='content_filter'||/safety|content.filter|moderation/i.test(upstream)) code='policy'
      else if(!response.ok||payload.error) code=({401:'credentials',403:'credentials',402:'quota',404:'model',429:'quota'})[http]||(http>=500?'upstream':'request')
      else {answer=typeof choice?.message?.content==='string'?choice.message.content.trim().slice(0,6500):'';code=answer?'ok':'empty'}
    }
  }catch {code='network'}
  return {answer,event:{provider:provider.id,model:provider.model,http,code,duration:Date.now()-begin,
    detail:code==='ok'?'Resposta recebida.':errors[code]+suffix,
    retry_at:['quota','network','upstream','credentials','configuration','model'].includes(code)?new Date(Date.now()+wait*1000).toISOString():null}}
}
export async function respond(messages,{cooldowns={},only,record,run=attempt}) {
  for(const p of providers.filter(p=>!only||p.id===only)){
    if(!only&&Date.parse(cooldowns[p.id])>Date.now()) continue
    const {answer,event}=await run(p,messages)
    await record(event)
    if(event.code==='ok') return {answer,provider:p.name}
    if(event.code==='policy') break
  }
  return null
}
