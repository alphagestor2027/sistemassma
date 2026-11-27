import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { epiFixture, applyDistributionUnits, applySheetDistribution, applyTechnicianStock } from './epi-db.mjs'
import {
  buildStockTemplateBytes,
  buildConsolidatedStockBytes,
  buildDeliveredPeriodBytes,
  parseStockSpreadsheet,
} from '../src/spreadsheet.js'
import { resolveCepLocation, formatCep } from '../src/cepRegion.js'
import { normalizeRequestStage } from '../src/epiData.js'

test('template .xlsx verde e planilha consolidada preservam estilos, cabeçalhos e leitura fiel', async () => {
  const sampleBytes = buildStockTemplateBytes([
    {
      name: 'BOTINA DE SEGURANÇA',
      ca: '43210',
      generic_cas: ['43211', '43212'],
      price: 139.9,
      qty: 12,
      minimum: 5,
      size: '41',
      color: 'Preto',
    },
    {
      name: 'BOLSA DE LONA',
      no_ca: true,
      ca: '',
      generic_cas: [],
      price: 75.5,
      qty: 4,
      minimum: 2,
      size: '',
      color: 'Verde',
    },
  ])
  assert.ok(sampleBytes.byteLength > 1000)
  // Assinatura ZIP PK\x03\x04 e presença das cores verdes institucionais no styles.xml
  assert.equal(sampleBytes[0], 0x50)
  assert.equal(sampleBytes[1], 0x4b)
  const rawAscii = new TextDecoder().decode(sampleBytes)
  assert.match(rawAscii, /FF15803D/) // Verde identidade cabeçalho
  assert.match(rawAscii, /FF14532D/) // Verde escuro institucional

  const parsed = await parseStockSpreadsheet(sampleBytes, 'Template_Estoque_SSMA.xlsx')
  assert.equal(parsed.preErrors.length, 0)
  assert.equal(parsed.rows.length, 2)
  assert.equal(parsed.rows[0].name, 'BOTINA DE SEGURANÇA')
  assert.equal(parsed.rows[0].ca, '43210')
  assert.deepEqual(parsed.rows[0].generic_cas, ['43211', '43212'])
  assert.equal(parsed.rows[0].price, 139.9)
  assert.equal(parsed.rows[0].qty, 12)
  assert.equal(parsed.rows[0].minimum, 5)
  assert.equal(parsed.rows[0].size, '41')
  assert.equal(parsed.rows[0].color, 'Preto')
  assert.equal(parsed.rows[1].no_ca, true)

  const consolidatedBytes = buildConsolidatedStockBytes(
    [
      {
        material: 'BOTINA DE SEGURANÇA',
        ca: '43210',
        generics: '43211, 43212',
        region: 'Centro-Oeste',
        qty: 12,
      },
      {
        material: 'CAPACETE',
        ca: '12345',
        generics: '—',
        region: 'Nordeste',
        qty: 8,
      },
    ],
    [
      {
        material: 'BOTINA DE SEGURANÇA',
        ca: '43210',
        generics: '43211, 43212',
        qty: 3,
        project: 'Projeto Norte',
        region: 'Centro-Oeste',
      },
    ],
  )
  const consolidatedXml = new TextDecoder().decode(consolidatedBytes)
  assert.match(consolidatedXml, /CA Principal/)
  assert.match(consolidatedXml, /CA Genérico/)
  assert.match(consolidatedXml, /TOTAL GERAL DE ITENS/)
  assert.match(consolidatedXml, /20 item\(ns\) no total/)
  assert.match(consolidatedXml, /Centro-Oeste/)
  assert.match(consolidatedXml, /Projeto Norte/)

  const deliveredPeriodBytes = buildDeliveredPeriodBytes(
    [
      {
        project: 'DATAPREV-DF',
        region: 'Centro-Oeste',
        state: 'DF',
        material: 'BOTINA DE SEGURANÇA',
        ca: '43210',
        qty: 2,
        cents: 29400,
      },
    ],
    { start: '2026-11-01', end: '2026-11-30' },
  )
  const deliveredPeriodXml = new TextDecoder().decode(deliveredPeriodBytes)
  assert.match(deliveredPeriodXml, /ITENS ENVIADOS POR PROJETO E REGIÃO \(CONSOLIDADO\)/)
  assert.match(deliveredPeriodXml, /01\/11\/2026 a 30\/11\/2026/)
  assert.match(deliveredPeriodXml, /DATAPREV-DF/)
  assert.match(deliveredPeriodXml, /Por projeto/)
  assert.match(deliveredPeriodXml, /Por região/)
})

test('localizador de CEP identifica UF e macrorregião em todas as 5 regiões do Brasil', () => {
  assert.equal(formatCep('70040010'), '70040-010')
  assert.deepEqual(resolveCepLocation('70040-010'), {
    cep: '70040-010',
    digits: '70040010',
    uf: 'DF',
    region: 'Centro-Oeste',
  })
  assert.equal(resolveCepLocation('01310100').region, 'Sudeste')
  assert.equal(resolveCepLocation('01310100').uf, 'SP')
  assert.equal(resolveCepLocation('40020000').region, 'Nordeste')
  assert.equal(resolveCepLocation('40020000').uf, 'BA')
  assert.equal(resolveCepLocation('69005070').region, 'Norte')
  assert.equal(resolveCepLocation('69005070').uf, 'AM')
  assert.equal(resolveCepLocation('80010000').region, 'Sul')
  assert.equal(resolveCepLocation('80010000').uf, 'PR')
})

test('importação de estoque via planilha: isolamento por técnico, atualização sem duplicar, log detalhado e deleção automática do arquivo; novos status de solicitações e Correios com CEP/tipo/projeto', async () => {
  const { owner, tech, employee, pg, call } = await epiFixture()
  try {
    await pg.query('update public.ssma_profiles set is_master=true where user_id=$1', [owner])
    await applyDistributionUnits(pg)
    await applySheetDistribution(pg)
    await applyTechnicianStock(pg)

    const colleague = randomUUID()
    const blockedTech = randomUUID()
    await pg.query('insert into auth.users(id) values($1),($2)', [colleague, blockedTech])
    await pg.query(
      "insert into public.ssma_profiles(user_id,username,display_name,permissions,coverage) values ($1,'colega2','Colega Isolado',array['epi.estoque','epi.solicitacoes'],array['RJ']),($2,'semestoque','Sem Permissão',array['epi.solicitacoes'],array['DF'])",
      [colleague, blockedTech],
    )
    await pg.query(
      "update public.ssma_profiles set permissions=array['epi.estoque','epi.solicitacoes','epi.financeiro','epi.ficha','epi.correios','epi.historico'], coverage=array['DF'] where user_id=$1",
      [tech],
    )
    await pg.query(
      "update public.ssma_records set details=details||jsonb_build_object('technicianId',$2::text) where id=$1",
      [employee, tech],
    )

    const manage = (actor, action, p) => call(actor, 'ssma_epi_manage', { action, p })

    // Técnico sem permissão de estoque não pode importar
    await assert.rejects(
      manage(blockedTech, 'import_stage_file', { file_name: 'teste.xlsx', byte_size: 120 }),
      /Sem permissão/,
    )

    // Técnico 1 cadastra um item inicial manualmente
    const existingId = randomUUID()
    await manage(tech, 'material', {
      id: existingId,
      name: 'Botina Couro',
      ca: '43210',
      size: '40',
      color: 'Preto',
      price: 100,
      qty: 5,
      minimum: 2,
    })

    // 1. Etapa de staging grava o arquivo temporário no banco
    const staged = await manage(tech, 'import_stage_file', {
      file_name: 'planilha_deuzilania.xlsx',
      byte_size: 4096,
      raw_payload: 'PK_TEMP_DATA',
    })
    assert.ok(staged.file_id)
    assert.equal(
      (await pg.query('select count(*)::int as n from ssma_epi.stock_import_files where id=$1', [staged.file_id])).rows[0]
        .n,
      1,
    )

    // Colega não pode importar no estoque do técnico 1
    await assert.rejects(
      manage(colleague, 'import_stock_batch', {
        region_id: tech,
        rows: [{ line: 4, name: 'Invasão', ca: '999', no_ca: false, price: 10, qty: 1, minimum: 1, size: '', color: '' }],
      }),
      /próprio perfil|não autorizado/,
    )

    // 2. Processamento do lote: atualiza Botina existente sem duplicar + cria Óculos novo + captura erro de linha inválida
    const batch = await manage(tech, 'import_stock_batch', {
      rows: [
        {
          line: 4,
          name: 'Botina Couro',
          ca: '43210',
          no_ca: false,
          generic_cas: ['43211'],
          price: 120,
          qty: 15,
          minimum: 6,
          size: '40',
          color: 'Preto',
        },
        {
          line: 5,
          name: 'Óculos Incolor',
          ca: '11268',
          no_ca: false,
          generic_cas: [],
          price: 18.5,
          qty: 30,
          minimum: 10,
          size: 'Único',
          color: 'Incolor',
        },
        {
          line: 6,
          name: '',
          ca: '',
          no_ca: false,
          generic_cas: [],
          price: 10,
          qty: 1,
          minimum: 0,
          size: '',
          color: '',
        },
      ],
    })
    assert.equal(batch.results.length, 3)
    assert.equal(batch.results[0].status, 'updated')
    assert.equal(batch.results[1].status, 'created')
    assert.equal(batch.results[2].status, 'error')

    // 3. Finalização deleta automaticamente o arquivo do banco sem interferir nos materiais atualizados
    const finishedLog = await manage(tech, 'import_finish', {
      file_id: staged.file_id,
      file_name: 'planilha_deuzilania.xlsx',
      total_rows: 3,
      created_count: 1,
      updated_count: 1,
      unchanged_count: 0,
      error_count: 1,
      entries: batch.results,
    })
    assert.equal(finishedLog.file_deleted, true)
    assert.equal(
      (await pg.query('select count(*)::int as n from ssma_epi.stock_import_files where id=$1', [staged.file_id])).rows[0]
        .n,
      0,
      'Arquivo temporário deve ser removido automaticamente do banco de dados',
    )

    // Confirma que não houve duplicação e que colega isolado continua sem ver o estoque nem os logs do técnico 1
    const techWs = await call(tech, 'ssma_epi_workspace')
    assert.equal(techWs.materials.length, 2, 'Item existente deve ser atualizado sem duplicar')
    const updatedBoot = techWs.materials.find((m) => m.ca === '43210')
    assert.equal(updatedBoot.qty, 15)
    assert.equal(Number(updatedBoot.price), 120)
    assert.deepEqual(updatedBoot.generic_cas, ['43211'])

    const colleagueWs = await call(colleague, 'ssma_epi_workspace')
    assert.equal(colleagueWs.materials.length, 0, 'Outro técnico não pode ver o estoque sem permissão Master')
    assert.equal((await manage(colleague, 'import_logs', {})).length, 0)
    assert.equal((await manage(tech, 'import_logs', {})).length, 1)
    assert.equal((await manage(owner, 'import_logs', {})).length, 1)

    // 4. Solicitações com os 5 status: Solicitações recebidas -> Para Aprovação do Gestor -> Em Separação -> Enviada -> Concluída
    const goggles = techWs.materials.find((m) => m.ca === '11268')
    const reqId = randomUUID()
    await call(null, 'ssma_epi_portal', {
      action: 'submit',
      p: {
        employee_id: employee,
        id: reqId,
        items: [
          { id: updatedBoot.id, qty: 2 },
          { id: goggles.id, qty: 3 },
        ],
      },
    })
    let req = (await call(tech, 'ssma_epi_workspace')).requests.find((q) => q.id === reqId)
    assert.equal(req.stage, 'Solicitações recebidas')
    assert.equal(normalizeRequestStage(req), 'Solicitações recebidas')

    await manage(tech, 'progress', {
      request_id: reqId,
      stage: 'Para Aprovação do Gestor',
      previous_stage: 'Solicitações recebidas',
      previous_postal: '',
      postal: '',
    })
    await manage(tech, 'progress', {
      request_id: reqId,
      stage: 'Em Separação',
      previous_stage: 'Para Aprovação do Gestor',
      previous_postal: '',
      postal: '',
    })
    await manage(tech, 'progress', {
      request_id: reqId,
      stage: 'Enviada',
      previous_stage: 'Em Separação',
      previous_postal: '',
      postal: 'BR555666777DF',
    })
    await manage(tech, 'progress', {
      request_id: reqId,
      stage: 'Concluída',
      previous_stage: 'Enviada',
      previous_postal: 'BR555666777DF',
      postal: 'BR555666777DF',
    })

    let wsAfterReq = await call(tech, 'ssma_epi_workspace')
    req = wsAfterReq.requests.find((q) => q.id === reqId)
    assert.equal(req.status, 'Entregue')
    assert.equal(req.stage, 'Concluída')
    assert.equal(normalizeRequestStage(req), 'Concluída')
    assert.equal(wsAfterReq.materials.find((m) => m.id === updatedBoot.id).qty, 13)
    assert.equal(wsAfterReq.materials.find((m) => m.id === goggles.id).qty, 27)
    assert.equal(wsAfterReq.materials.find((m) => m.id === updatedBoot.id).reserved, 0)

    // 4b. Editar itens da solicitação concluída (alterar quantidade de Botina 2 -> 4 e excluir Óculos) altera o estoque automaticamente!
    await manage(tech, 'edit_request', {
      request_id: reqId,
      status: 'Entregue',
      note: 'Ajuste de itens entregues',
      postal: 'BR555666777DF',
      quantities: { [updatedBoot.id]: 4 },
      removed_materials: [goggles.id],
    })
    wsAfterReq = await call(tech, 'ssma_epi_workspace')
    // Botina: 13 - 2 = 11; Óculos excluído: 27 + 3 = 30 de volta ao estoque!
    assert.equal(wsAfterReq.materials.find((m) => m.id === updatedBoot.id).qty, 11)
    assert.equal(wsAfterReq.materials.find((m) => m.id === goggles.id).qty, 30)

    // 4c. Remover solicitação/ficha concluída estorna as 4 Botinas de volta para 15 sem erro!
    await manage(tech, 'remove_request', { request_id: reqId })
    wsAfterReq = await call(tech, 'ssma_epi_workspace')
    assert.equal(wsAfterReq.materials.find((m) => m.id === updatedBoot.id).qty, 15)
    assert.ok(!wsAfterReq.requests.some((q) => q.id === reqId))

    // 4d. Emitir ficha manual, editar quantidade + excluir item em ssma_epi_sheet('edit') e excluir ficha
    const sheetCtx = await call(tech, 'ssma_epi_sheet', {
      action: 'context',
      p: { employee_id: employee },
    })
    const manualSheetId = randomUUID()
    const issuedDoc = await call(tech, 'ssma_epi_sheet', {
      action: 'issue',
      p: {
        id: manualSheetId,
        employee_id: employee,
        version: sheetCtx.version,
        new_items: [
          { id: updatedBoot.id, qty: 3, reason: 'Inicial' },
          { id: goggles.id, qty: 2, reason: 'Inicial' },
        ],
        settings: {
          identity: { name: 'Ana Silva', unit: 'Projeto Norte' },
          legal: 'Legal',
          term: 'Termo',
          logo: '',
          place: 'Brasília',
          reasons: {},
        },
      },
    })
    // Após emissão: Botina = 12, Óculos = 28
    wsAfterReq = await call(tech, 'ssma_epi_workspace')
    assert.equal(wsAfterReq.materials.find((m) => m.id === updatedBoot.id).qty, 12)
    assert.equal(wsAfterReq.materials.find((m) => m.id === goggles.id).qty, 28)

    // Edita ficha: reduz Botina de 3 -> 1 (+2 ao estoque -> 14) e exclui Óculos (+2 ao estoque -> 30)
    const bootKey = `${manualSheetId}/${updatedBoot.id}`
    const gogglesKey = `${manualSheetId}/${goggles.id}`
    const editedDoc = await call(tech, 'ssma_epi_sheet', {
      action: 'edit',
      p: {
        id: manualSheetId,
        employee_id: employee,
        revision: issuedDoc.revision,
        removed: [gogglesKey],
        item_quantities: { [bootKey]: 1 },
        document_items: [],
        settings: issuedDoc.settings,
      },
    })
    assert.equal(editedDoc.snapshot.items.length, 1)
    assert.equal(editedDoc.snapshot.items[0].qty, 1)
    wsAfterReq = await call(tech, 'ssma_epi_workspace')
    assert.equal(wsAfterReq.materials.find((m) => m.id === updatedBoot.id).qty, 14)
    assert.equal(wsAfterReq.materials.find((m) => m.id === goggles.id).qty, 30)

    // Exclui ficha editada: devolve a 1 Botina restante -> volta para 15!
    await call(tech, 'ssma_epi_sheet', {
      action: 'delete',
      p: { id: manualSheetId, employee_id: employee, revision: editedDoc.revision },
    })
    wsAfterReq = await call(tech, 'ssma_epi_workspace')
    assert.equal(wsAfterReq.materials.find((m) => m.id === updatedBoot.id).qty, 15)

    // 4e. Inclusão de novo item via edit_request + sincronização total ao usar clear_requests em fichas entregues
    const clearTestReqId = randomUUID()
    await call(null, 'ssma_epi_portal', {
      action: 'submit',
      p: {
        employee_id: employee,
        id: clearTestReqId,
        items: [{ id: updatedBoot.id, qty: 2 }],
      },
    })
    await manage(tech, 'progress', {
      request_id: clearTestReqId,
      stage: 'Concluída',
      previous_stage: 'Solicitações recebidas',
      previous_postal: '',
      postal: '',
    })
    // Inclui Óculos (qty 3) na solicitação já entregue via edit_request
    await manage(tech, 'edit_request', {
      request_id: clearTestReqId,
      status: 'Entregue',
      note: 'Inclusão via edição',
      postal: '',
      quantities: { [updatedBoot.id]: 2 },
      removed_materials: [],
      added_materials: [{ id: goggles.id, qty: 3, reason: 'Inicial' }],
    })
    wsAfterReq = await call(tech, 'ssma_epi_workspace')
    assert.equal(wsAfterReq.materials.find((m) => m.id === updatedBoot.id).qty, 13)
    assert.equal(wsAfterReq.materials.find((m) => m.id === goggles.id).qty, 27)
    assert.equal((await call(tech, 'ssma_epi_stock_costs')).length, 2)

    // Limpar solicitações agora devolve TUDO ao estoque e limpa movimentos/financeiro!
    await manage(tech, 'clear_requests', {})
    wsAfterReq = await call(tech, 'ssma_epi_workspace')
    assert.equal(wsAfterReq.materials.find((m) => m.id === updatedBoot.id).qty, 15)
    assert.equal(wsAfterReq.materials.find((m) => m.id === goggles.id).qty, 30)
    assert.equal(wsAfterReq.requests.length, 0)
    assert.equal(
      wsAfterReq.movements.filter((v) => v.kind === 'Saída').length,
      0,
      'Movimentações de saída devem ser estornadas após limpar/remover fichas',
    )
    assert.deepEqual(await call(tech, 'ssma_epi_stock_costs'), [])
    assert.deepEqual(await call(tech, 'ssma_epi_dashboard'), [])

    // 4f. Testa edição adicionando novo item via ssma_epi_sheet('edit') + exclusão de ficha legada sem request_id
    const sheetCtx2 = await call(tech, 'ssma_epi_sheet', {
      action: 'context',
      p: { employee_id: employee },
    })
    const docId2 = randomUUID()
    const issued2 = await call(tech, 'ssma_epi_sheet', {
      action: 'issue',
      p: {
        id: docId2,
        employee_id: employee,
        version: sheetCtx2.version,
        new_items: [{ id: updatedBoot.id, qty: 2, reason: 'Inicial' }],
        settings: {
          identity: { name: 'Ana Silva', unit: 'Projeto Norte' },
          legal: 'Legal',
          term: 'Termo',
          logo: '',
          place: 'Brasília',
          reasons: {},
        },
      },
    })
    // Adiciona Óculos via document_items durante edição da ficha
    const edited2 = await call(tech, 'ssma_epi_sheet', {
      action: 'edit',
      p: {
        id: docId2,
        employee_id: employee,
        revision: issued2.revision,
        removed: [],
        item_quantities: { [`${docId2}/${updatedBoot.id}`]: 2 },
        document_items: [{ id: goggles.id, qty: 4, reason: 'Inicial' }],
        settings: issued2.settings,
      },
    })
    assert.equal(edited2.snapshot.items.length, 2)
    wsAfterReq = await call(tech, 'ssma_epi_workspace')
    assert.equal(wsAfterReq.materials.find((m) => m.id === updatedBoot.id).qty, 13)
    assert.equal(wsAfterReq.materials.find((m) => m.id === goggles.id).qty, 26)

    // Exclui ficha -> tudo retorna ao saldo original (15 e 30)
    await call(tech, 'ssma_epi_sheet', {
      action: 'delete',
      p: { id: docId2, employee_id: employee, revision: edited2.revision },
    })
    wsAfterReq = await call(tech, 'ssma_epi_workspace')
    assert.equal(wsAfterReq.materials.find((m) => m.id === updatedBoot.id).qty, 15)
    assert.equal(wsAfterReq.materials.find((m) => m.id === goggles.id).qty, 30)
    assert.deepEqual(await call(tech, 'ssma_epi_stock_costs'), [])

    // 5. Correios: CEP identificando UF, tipo Colaborador / Fornecedor / Outros e decisão de custo no projeto
    const logistics = (actor, action, p) => call(actor, 'ssma_epi_logistics', { action, p })
    await logistics(tech, 'ship', {
      id: randomUUID(),
      date: '2026-11-26',
      tracking: 'SEDEX-COLAB-01',
      mode: 'SEDEX',
      cep: '70040010',
      recipient_type: 'Colaborador',
      employee_id: employee,
      charge_project: true,
      project: 'Projeto Norte',
      price: 42.5,
    })
    await logistics(tech, 'ship', {
      id: randomUUID(),
      date: '2026-11-26',
      tracking: 'PAC-FORN-02',
      mode: 'PAC',
      cep: '71608-900',
      recipient_type: 'Fornecedor',
      recipient: 'Laboratório Dielétrico LTDA',
      charge_project: false,
      project: 'SSMA',
      price: 68.9,
    })
    await logistics(tech, 'ship', {
      id: randomUUID(),
      date: '2026-11-26',
      tracking: 'PAC-OUTROS-03',
      mode: 'PAC',
      cep: '70710-900',
      recipient_type: 'Outros',
      recipient: 'Base Operacional Apoio',
      charge_project: true,
      project: 'Projeto Norte',
      price: 29.0,
    })

    const shipData = await logistics(tech, 'shipments', {})
    assert.equal(shipData.rows.length, 3)
    const sColab = shipData.rows.find((s) => s.tracking === 'SEDEX-COLAB-01')
    const sForn = shipData.rows.find((s) => s.tracking === 'PAC-FORN-02')
    const sOutros = shipData.rows.find((s) => s.tracking === 'PAC-OUTROS-03')

    assert.equal(sColab.cep, '70040-010')
    assert.equal(sColab.state, 'DF')
    assert.equal(sColab.recipient_type, 'Colaborador')
    assert.equal(sColab.charge_project, true)
    assert.equal(sColab.project, 'Projeto Norte')

    assert.equal(sForn.cep, '71608-900')
    assert.equal(sForn.state, 'DF')
    assert.equal(sForn.recipient_type, 'Fornecedor')
    assert.equal(sForn.charge_project, false)
    assert.equal(sForn.project, 'SSMA')

    assert.equal(sOutros.recipient_type, 'Outros')
    assert.equal(sOutros.charge_project, true)
    assert.equal(sOutros.project, 'Projeto Norte')

    // Admin Master enxerga tudo no painel consolidado
    const masterShip = await logistics(owner, 'shipments', {})
    assert.equal(masterShip.rows.length, 3)
  } finally {
    await pg.close()
  }
})
