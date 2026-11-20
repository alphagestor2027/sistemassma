import { createClient } from 'npm:@supabase/supabase-js@2.119.0'

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Cache-Control': 'no-store',
}
const reply = (status: number, body: object) => Response.json(body, { status, headers })
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers })
  if (req.method !== 'POST') return reply(405, { message: 'Use POST.' })
  const authorization = req.headers.get('Authorization')
  if (!authorization) return reply(401, { message: 'Entre no painel Master.' })
  const url = Deno.env.get('SUPABASE_URL')!
  const user = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  })
  try {
    const { data: master, error: denied } = await user.rpc('ssma_master', {
      action: 'authorize_creation',
      p: {},
    })
    if (denied || !master) return reply(403, { message: 'Acesso exclusivo do Master.' })
    const body = await req.json().catch(() => null)
    const login = typeof body?.username === 'string' ? body.username.trim().toLowerCase() : ''
    const name = typeof body?.name === 'string' ? body.name.trim() : ''
    const password = body?.password
    if (
      !/^[a-z0-9][a-z0-9._-]{2,39}$/.test(login) ||
      login === 'cesar' ||
      !name ||
      name.length > 120 ||
      typeof password !== 'string' ||
      password.length < 8 ||
      new TextEncoder().encode(password).length > 72
    )
      return reply(400, {
        message: 'Confira nome, usuário e senha (mínimo de 8 caracteres e máximo de 72 bytes).',
      })
    const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
    const { data, error } = await admin.auth.admin.createUser({
      email: login + '@ssma.invalid',
      password,
      email_confirm: true,
      app_metadata: { ssma_technician: { created_by: master, name } },
    })
    if (error) {
      const duplicate = ['email_exists', 'user_already_exists'].includes(error.code || '')
      return reply(duplicate ? 409 : 400, {
        message: duplicate
          ? 'Este usuário já está cadastrado.'
          : 'Cadastro recusado. Confira o usuário e a senha e atualize a lista.',
      })
    }
    return reply(201, { id: data.user.id })
  } catch {
    return reply(500, {
      message: 'Falha ao cadastrar o técnico. Atualize a lista antes de tentar novamente.',
    })
  }
})
