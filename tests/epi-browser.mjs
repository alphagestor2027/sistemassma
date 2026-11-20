import { chromium } from '@playwright/test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { epiFixture } from './epi-db.mjs'

const { pg, owner, tech, employee, call } = await epiFixture()
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
      if (name === 'ssma-create-technician') {
        await call(actor, 'ssma_master', { action: 'authorize_creation', p: {} })
        const { name: displayName, username, coverage } = req.postDataJSON()
        const id = crypto.randomUUID()
        await pg.transaction(async (tx) => {
          await tx.query('insert into auth.users(id,email) values($1,$2)', [id, username + '@ssma.invalid'])
          await tx.query('update auth.users set raw_app_meta_data=$1 where id=$2', [
            JSON.stringify({
              ssma_technician: { created_by: actor, name: displayName, coverage },
            }),
            id,
          ])
        })
        body = { id }
      } else if (name === 'token')
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
        body = await pg.transaction(async (tx) => {
          await tx.exec('set local role authenticated')
          await tx.query("select set_config('request.jwt.claim.sub',$1,true)", [actor])
          return (await tx.query('select * from public.ssma_records')).rows
        })
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
  await pg.query('update public.ssma_profiles set is_master=true where user_id=$1', [owner])
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
  const link = base + '/emissaoepi'
  await button(admin, 'Estoque').click()
  await pg.query("insert into ssma_epi.ca_catalog(ca,fichas) values ('111',$1)", [
    JSON.stringify([
      {
        equipamento: 'LUVA ISOLANTE',
        fabricante: 'Fabricante de teste',
        validade: '01/11/2027',
        situacao: 'VÁLIDO',
        laudos: [{ norma: 'Norma de teste' }],
      },
    ]),
  ])
  await button(admin, 'Consultar CA').click()
  await admin.getByLabel('Número do CA').fill('99999999')
  await admin.getByText(/99999999 não encontrado/).waitFor()
  await admin.getByLabel('Número do CA').fill('111')
  await admin.getByText('Fabricante de teste', { exact: true }).waitFor()
  await button(admin, 'Usar no cadastro de material').click()
  assert.equal(await admin.getByLabel('CA', { exact: true }).inputValue(), '111')
  assert.equal(await admin.getByLabel('Nome do material').inputValue(), 'LUVA ISOLANTE')
  assert.equal(await admin.getByLabel('Nova validade do CA').count(), 0)
  await admin.getByLabel('Deseja atualizar a data de validade do CA?').check()
  await admin.getByLabel('Nova validade do CA').fill('2029-03-15')
  await admin.getByLabel('CA', { exact: true }).fill('000111')
  await admin.getByRole('heading', { name: 'CA 111 · LUVA ISOLANTE' }).waitFor()
  await admin.getByRole('combobox', { name: 'Cor', exact: true }).selectOption('Azul')
  await admin.getByRole('combobox', { name: 'Cor', exact: true }).selectOption('')
  await admin.getByLabel('Nome do material').fill('Luva isolante')
  await admin.getByLabel('CA', { exact: true }).fill('111')
  await admin.getByLabel('Deseja atualizar a data de validade do CA?').check()
  await admin.getByLabel('Nova validade do CA').fill('2029-03-15')
  await admin.getByLabel('Valor unitário (R$)', { exact: true }).fill('30')
  await admin.getByLabel('Quantidade', { exact: true }).fill('3')
  const startDay = new Date().toISOString().slice(0, 10)
  await admin.getByLabel('Data inicial do certificado ou ensaio elétrico').fill(startDay)
  await admin.getByText(/Vencimento da luva:/).waitFor()
  assert.equal(await admin.getByLabel('Centro de custo do estoque').count(), 0)
  assert.match(await admin.getByLabel('Valor unitário (R$)', { exact: true }).inputValue(), /30,00/)
  assert.ok(
    await admin.getByLabel('Estoque regional').locator('option').filter({ hasText: 'Sul · PR' }).count(),
  )
  await admin.getByLabel('Tamanho / numeração').fill('M')
  await admin.getByLabel('Estoque regional').selectOption({ index: 1 })
  await button(admin, 'Salvar material').click()
  await admin.getByRole('cell', { name: 'Luva isolante · Tam. M', exact: true }).waitFor()
  await button(admin, 'Consultar CA').click()
  await admin.getByLabel('Número do CA').fill('111')
  await admin.getByText('15/03/2029', { exact: true }).waitFor()
  await admin.getByText('01/11/2027', { exact: true }).waitFor()
  await admin.getByLabel('Deseja atualizar a data de validade do CA?').check()
  await admin.getByLabel('Nova validade do CA').fill('2030-04-16')
  await button(admin, 'Salvar validade do CA').click()
  await admin.getByText('16/04/2030', { exact: true }).waitFor()
  const portal = await client(null)
  await portal.setViewportSize({ width: 390, height: 844 })
  await portal.goto(link)
  await portal.getByLabel('Nome do colaborador').selectOption(employee)
  await portal.getByLabel('Estado', { exact: true }).selectOption('DF')
  await portal.getByLabel('Quantidade de Luva isolante · Tam. M').fill('2')
  await button(portal, 'Enviar solicitação').click()
  await portal.getByRole('cell', { name: 'Pedido recebido', exact: true }).waitFor()
  assert.ok(await portal.evaluate(() => document.documentElement.scrollWidth <= innerWidth))

  await button(admin, 'Solicitações').click()
  const code = await portal.getByLabel('Código de rastreio do pedido').inputValue()
  await admin.getByLabel('Etapa do pedido').selectOption('Enviado pelos Correios')
  await admin.getByLabel('Número de rastreamento dos Correios').fill('AA123456789BR')
  await button(admin, 'Salvar andamento').click()
  await admin.getByText(/Correios: AA123456789BR/).waitFor()
  await portal.reload()
  await portal.getByLabel('Código de rastreio do pedido').fill(code)
  await button(portal, 'Consultar andamento').click()
  await portal.getByText('AA123456789BR', { exact: true }).waitFor()
  await admin.getByText(/Despesa da entrega:/).waitFor()
  await button(admin, 'Confirmar entrega').click()
  await admin.locator('article .badge').filter({ hasText: 'Entregue' }).waitFor()
  await button(admin, 'Financeiro').click()
  await admin.getByRole('cell', { name: 'R$ 60,00', exact: true }).first().waitFor()
  await pg.query("update ssma_epi.requests set closed_at=now()-interval '365 days' where status='Entregue'")
  await admin.reload()
  await button(admin, 'Gestão de EPIs').click()
  await button(admin, 'Ficha digital').click()
  await admin.getByLabel('Consultar colaborador').selectOption(employee)
  await admin.getByText('Está na hora de realizar a substituição do material.').waitFor()
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
  await portal.getByText('Está na hora de realizar a substituição do material.').waitFor()
  await pg.query(
    "insert into public.ssma_records(owner_id,module,title,unit,event_date) values ($1,'acidentes','Acidente DF','Obra / DF','2020-01-02'),($1,'acidentes','Acidente SP','Base / SP','2020-01-02'),($1,'acidentes','Acidente anterior','Obra / DF','2020-01-01')",
    [owner],
  )
  await button(admin, 'Painel Master').click()
  await admin.getByLabel('Técnico de segurança', { exact: true }).selectOption(owner)
  await admin.getByLabel('Região', { exact: true }).selectOption('Centro-Oeste')
  const ufFilter = admin.getByLabel('Estado', { exact: true })
  assert.equal(await ufFilter.locator('option[value=SP]').count(), 0)
  await ufFilter.selectOption('DF')
  await admin.getByLabel('Período', { exact: true }).selectOption('custom')
  await admin.getByLabel('Data inicial').fill('2020-01-02')
  await admin.getByLabel('Data final').fill('2020-01-02')
  const accidentCard = admin.locator('.kpi').filter({ hasText: 'Acidentes no período' })
  assert.equal(await accidentCard.locator('strong').textContent(), '1')
  await admin.getByRole('img', { name: 'Evolução no período: 1 acidente e 0 incidentes' }).waitFor()
  await admin.getByLabel('Região', { exact: true }).selectOption('')
  assert.equal(await accidentCard.locator('strong').textContent(), '2')
  await admin.getByLabel('Data final').fill('2020-01-01')
  await admin.getByRole('alert').filter({ hasText: 'Informe as duas datas' }).waitFor()
  await admin.getByLabel('Período', { exact: true }).selectOption('7')
  assert.equal(await accidentCard.locator('strong').textContent(), '0')
  await ufFilter.selectOption('DF')
  await admin.getByRole('cell', { name: 'Projeto Norte', exact: true }).waitFor()
  await admin
    .getByRole('navigation', { name: 'Administração Master' })
    .getByRole('button', { name: 'Gestão de técnicos' })
    .click()
  await button(admin, 'Cadastrar técnico').click()
  await admin.getByLabel('Nome completo', { exact: true }).fill('Maria de Teste')
  await admin.getByLabel('Usuário de acesso').fill('maria.local')
  await admin.getByLabel('Senha inicial').fill('local-fixture-only')
  await admin.getByRole('checkbox', { name: 'Centro-Oeste', exact: true }).check()
  await admin.getByRole('checkbox', { name: 'SP', exact: true }).check()
  await button(admin, 'Criar conta do técnico').click()
  await admin.getByRole('heading', { name: 'Cadastro de Maria de Teste' }).waitFor()
  const created = (
    await pg.query("select user_id,permissions from public.ssma_profiles where username='maria.local'")
  ).rows[0]
  assert.deepEqual(created.permissions, [])
  assert.ok(await admin.getByRole('checkbox', { name: 'Centro-Oeste', exact: true }).isChecked())
  assert.ok(await admin.getByRole('checkbox', { name: 'SP', exact: true }).isChecked())
  const techPage = await client(created.user_id)
  await techPage.goto(base)
  await techPage.locator('[name=username]').fill('maria.local')
  await techPage.locator('[name=password]').fill('local-fixture-only')
  await button(techPage, 'Entrar no sistema').click()
  await techPage.getByRole('heading', { name: 'Dashboard Geral', exact: true }).waitFor()
  assert.equal(await button(techPage, 'Painel Master').count(), 0)
  await admin.getByRole('checkbox', { name: 'Centro-Oeste', exact: true }).uncheck()
  await admin.getByRole('checkbox', { name: 'MG', exact: true }).check()
  await admin.getByLabel('Nome do técnico').fill('Maria Silva')
  await admin.getByLabel('Acesso ao sistema').selectOption('Inativo')
  await button(admin, 'Salvar cadastro').click()
  await admin.getByRole('heading', { name: 'Cadastro de Maria Silva' }).waitFor()
  const coverage = await pg.query('select coverage from public.ssma_profiles where user_id=$1', [
    created.user_id,
  ])
  assert.deepEqual(coverage.rows[0], { coverage: ['MG', 'SP'] })
  await assert.rejects(
    () =>
      pg.query("update public.ssma_profiles set coverage=array['XX'] where user_id=$1", [created.user_id]),
    /coverage/,
  )
  await techPage.reload()
  await techPage.getByText(/Acesso desativado/).waitFor()
  const mariaRow = admin.getByRole('row').filter({ hasText: 'maria.local' })
  await button(mariaRow, 'Desbloquear').click()
  await mariaRow.getByRole('cell', { name: 'Ativo', exact: true }).waitFor()
  await techPage.reload()
  await techPage.getByRole('heading', { name: 'Dashboard Geral', exact: true }).waitFor()
  await button(mariaRow, 'Bloquear').click()
  await mariaRow.getByRole('cell', { name: 'Bloqueado', exact: true }).waitFor()
  admin.once('dialog', (dialog) => dialog.dismiss())
  await button(mariaRow, 'Remover').click()
  assert.ok(await mariaRow.isVisible())
  admin.once('dialog', (dialog) => dialog.accept())
  await button(mariaRow, 'Remover').click()
  await mariaRow.waitFor({ state: 'detached' })
  assert.equal((await pg.query('select 1 from auth.users where id=$1', [created.user_id])).rows.length, 0)
  await button(admin, 'Gerenciar Técnico regional').click()
  await admin.getByLabel('EPI · Estoque', { exact: true }).uncheck()
  await button(admin, 'Salvar permissões').click()
  await admin.getByText('Permissões salvas.', { exact: true }).waitFor()
  const updated = (await pg.query('select permissions from public.ssma_profiles where user_id=$1', [tech]))
    .rows[0]
  assert.ok(!updated.permissions.includes('epi.estoque'))
  if (process.env.MASTER_SCREENSHOT) {
    await admin.setViewportSize({ width: 1600, height: 1050 })
    await admin.screenshot({ path: process.env.MASTER_SCREENSHOT, fullPage: true })
  }
  assert.deepEqual(failures, [])
  console.log(
    'PASS: vinculação, estoque, portal individual em celular, entrega, financeiro, ficha de impressão e ensaio com SQL real em banco isolado.',
  )
} finally {
  await browser.close()
  await pg.close()
}
