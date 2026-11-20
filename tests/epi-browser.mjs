import { chromium } from '@playwright/test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { epiFixture } from './epi-db.mjs'

const { pg, owner, employee, call } = await epiFixture()
const installed = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || (existsSync(installed) ? installed : undefined),
})
const base = process.env.APP_URL || 'http://127.0.0.1:5173'
const failures = []
async function client(actor) {
  const context = await browser.newContext()
  const user = {
    id: actor,
    aud: 'authenticated',
    role: 'authenticated',
    email: 'gestao@ssma.invalid',
    app_metadata: { provider: 'email' },
    user_metadata: {},
    created_at: new Date().toISOString(),
  }
  const token =
    Buffer.from('{}').toString('base64url') +
    '.' +
    Buffer.from(JSON.stringify({ sub: actor, exp: Math.floor(Date.now() / 1000) + 3600 })).toString(
      'base64url',
    ) +
    '.signature'
  await context.route('https://fonts.googleapis.com/**', (route) => route.abort())
  await context.route('https://gotofoqjtjaeuicfqluo.supabase.co/**', async (route) => {
    const req = route.request(),
      url = new URL(req.url()),
      name = url.pathname.split('/').pop()
    try {
      let body
      if (name === 'token')
        body = {
          access_token: token,
          refresh_token: 'test-local',
          expires_in: 3600,
          token_type: 'bearer',
          user,
        }
      else if (name === 'ssma_profiles')
        body = (await pg.query('select * from public.ssma_profiles where user_id=$1', [actor])).rows[0]
      else if (name === 'ssma_records')
        body = (await pg.query('select * from public.ssma_records where owner_id=$1', [actor])).rows
      else if (name === 'user') body = user
      else body = await call(actor, name, req.postDataJSON() || {})
      await route.fulfill({ json: body })
    } catch (err) {
      console.error(err.message)
      failures.push(err.message)
      await route.fulfill({ status: 400, json: { message: err.message } })
    }
  })
  const page = await context.newPage()
  page.on('pageerror', (err) => failures.push(err.message))
  page.setDefaultTimeout(7500)
  return page
}
try {
  const admin = await client(owner)
  admin.on('pageerror', (e) => console.error(e.message))
  await admin.goto(base)
  await admin.locator('[name=username]').fill('gestao')
  await admin.locator('[name=password]').fill('local-test')
  await admin.getByRole('button', { name: 'Entrar no sistema' }).click()
  const button = (p, name) => p.getByRole('button', { name, exact: true })
  await button(admin, 'Gestão de EPIs').click()
  await button(admin, 'Regionais e vínculos').click()
  await admin.getByLabel('Estado', { exact: true }).selectOption('DF')
  await admin.getByLabel('Nome da regional').fill('Brasília')
  await button(admin, 'Salvar regional').click()
  await admin.getByRole('cell', { name: 'Brasília', exact: true }).waitFor()
  await admin.getByLabel('Colaborador', { exact: true }).selectOption(employee)
  await admin.getByLabel('Regional do colaborador').selectOption({ index: 1 })
  await button(admin, 'Salvar vínculo').click()
  await admin.getByRole('cell', { name: 'Ana Silva', exact: true }).waitFor()
  await admin.getByLabel('Colaborador vinculado').selectOption(employee)
  await button(admin, 'Gerar link individual').click()
  const link = await admin.getByLabel('Link para compartilhar com o colaborador').inputValue()
  await button(admin, 'Estoque').click()
  await button(admin, 'Cadastrar material').click()
  await admin.getByLabel('Nome do material').fill('Luva isolante')
  await admin.getByLabel('CA', { exact: true }).fill('111')
  await admin.getByLabel('Valor unitário (R$)', { exact: true }).fill('30')
  await admin.getByLabel('Quantidade', { exact: true }).fill('3')
  await admin.getByLabel('Tamanho / numeração').fill('M')
  await admin.getByLabel('Estoque regional').selectOption({ index: 1 })
  await button(admin, 'Salvar material').click()
  await admin.getByRole('cell', { name: 'Luva isolante · Tam. M', exact: true }).waitFor()
  const portal = await client(null)
  await portal.setViewportSize({ width: 390, height: 844 })
  await portal.goto(link)
  await portal.getByLabel('Nome do colaborador').selectOption(employee)
  await portal.getByLabel('Estado', { exact: true }).selectOption('DF')
  await portal.getByLabel('Quantidade de Luva isolante · Tam. M').fill('2')
  await button(portal, 'Enviar solicitação').click()
  await portal.getByRole('cell', { name: 'Solicitado', exact: true }).waitFor()
  assert.ok(await portal.evaluate(() => document.documentElement.scrollWidth <= innerWidth))

  await button(admin, 'Solicitações').click()
  await admin.getByLabel('Lançar despesa em').selectOption('Projeto')
  await button(admin, 'Confirmar entrega').click()
  await admin.locator('article .badge').filter({ hasText: 'Entregue' }).waitFor()
  await button(admin, 'Financeiro').click()
  await admin.getByRole('cell', { name: 'R$ 60,00', exact: true }).first().waitFor()
  await button(admin, 'Ficha digital').click()
  await admin.getByLabel('Consultar colaborador').selectOption(employee)
  await admin.getByRole('cell', { name: '111', exact: true }).waitFor()
  await admin.emulateMedia({ media: 'print' })
  assert.ok(await admin.getByRole('heading', { name: 'Ficha individual de entrega de EPI' }).isVisible())
  await admin.emulateMedia({ media: 'screen' })
  await button(admin, 'Ensaios e retornos').click()
  await admin.getByLabel('Entrega confirmada').selectOption({ index: 1 })
  await admin.getByLabel('Equipamento entregue').selectOption({ index: 1 })
  await admin.getByLabel('Número de série / patrimônio').fill('BR-001')
  await admin.getByLabel('Intervalo de reteste (dias)').fill('90')
  await admin.getByLabel('Próximo ensaio').fill('2027-02-01')
  await button(admin, 'Registrar equipamento').click()
  await admin.getByLabel('Laboratório de destino').fill('Lab DF')
  await button(admin, 'Registrar movimentação').click()
  await admin.locator('article .badge').filter({ hasText: 'Em trânsito' }).waitFor()
  await portal.reload()
  await portal.getByLabel('Nome do colaborador').selectOption(employee)
  await portal.getByLabel('Estado', { exact: true }).selectOption('DF')
  await portal.getByRole('cell', { name: 'Entregue', exact: true }).waitFor()
  assert.deepEqual(failures, [])
  console.log(
    'PASS: vinculação, estoque, portal individual em celular, entrega, financeiro, ficha de impressão e ensaio com SQL real em banco isolado.',
  )
} finally {
  await browser.close()
  await pg.close()
}
