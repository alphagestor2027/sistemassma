import { usePages } from './Pagination'
import { PriceField } from './PriceField'
import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  ShieldCheck,
  Plus,
  CirclePlus,
  Search,
  ShoppingCart,
  CircleCheck,
  TrendingUp,
  Pencil,
  Trash2,
  Boxes,
  Layers,
  AlertOctagon,
  Wallet,
  Download,
  Upload,
  FileSpreadsheet,
  ScrollText,
  CheckCircle2,
  XCircle,
  Info,
  X,
} from 'lucide-react'
import { CaExpiryEditor, CaResult, useCaLookup } from './CaCatalog'
import { Panel, ActionForm, Field, Select, Table, rpc } from './EpiShared'
import { available, variant, regionLabel, money, after365, stamp } from './epiData'
import { dateLabel, today } from './data'
import { buildStockTemplateBytes, parseStockSpreadsheet, triggerXlsxDownload } from './spreadsheet'

const materialColors = [
  'Amarelo',
  'Azul',
  'Azul-marinho',
  'Bege',
  'Branco',
  'Cinza',
  'Incolor',
  'Laranja',
  'Marrom',
  'Multicolorido',
  'Preto',
  'Rosa',
  'Roxo',
  'Verde',
  'Vermelho',
  'Vinho',
  'Outra',
]
const numberProps = { type: 'number', min: 0, step: 1 }

export function Stock({ db, data, profile, save, refresh, onChange, initialFocus }) {
  const [noCA, setNoCA] = useState(false),
    [search, setSearch] = useState(() => data.materials.find((m) => m.id === initialFocus)?.name || ''),
    [show, setShow] = useState('')
  const [ca, setCa] = useState(''),
    [name, setName] = useState(null),
    [ficha, setFicha] = useState(0)
  const [selected, setSelected] = useState(null)
  const editing = show === 'edit' ? selected : null
  const formHeading = useRef(null)
  useEffect(() => {
    if (show === 'edit' || show === 'delete') formHeading.current?.focus()
  }, [show, selected])

  function selectMaterial(material, mode) {
    setSelected(material)
    setShow(mode)
    setName(material.name)
    setCa(material.ca)
    setNoCA(material.no_ca)
    setFicha(null)
    setStart(material.glove_start || '')
    setManualGlove(material.insulating_glove)
  }

  const stockCa = !show && /^\d{1,70}$/.test(search.trim()) ? search.trim() : ''
  const lookup = useCaLookup(db, show === 'lookup' || ((show === 'new' || editing) && !noCA) ? ca : stockCa)
  const fichaIndex = ficha ?? Math.max(0, lookup?.records?.findIndex((record) => record.sheet_key === editing?.ca_sheet_key) ?? 0)
  const sheet = lookup?.records?.[fichaIndex]
  const suggested = sheet?.equipamento || ''

  function changeCa(value) {
    setStart('')
    setManualGlove(false)
    setCa(value)
    setFicha(0)
  }

  function open(mode) {
    setStart('')
    setManualGlove(false)
    setShow(show === mode ? '' : mode)
    setNoCA(false)
    changeCa('')
    setName(null)
  }

  const [unit, setUnit] = useState('')
  const [masterTargets, setMasterTargets] = useState(null)

  useEffect(() => {
    if (!profile.is_master) return
    let active = true
    rpc(db, 'manage', { action: 'all_stock_targets', p: {} })
      .then((res) => {
        if (active && Array.isArray(res) && res.length) setMasterTargets(res)
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [db, profile.is_master, data.regions.length])

  const units = useMemo(() => {
    if (profile.is_master && masterTargets?.length) {
      const map = new Map(masterTargets.map((t) => [t.id, t.label]))
      for (const r of data.regions) {
        if (!map.has(r.id)) map.set(r.id, r.distribution_unit ? 'Unidade ' + r.distribution_unit : regionLabel(r))
      }
      return [...map.entries()]
    }
    return data.regions
      .filter((r) => r.distribution_unit || r.individual)
      .map((r) => [r.id, r.distribution_unit ? 'Unidade ' + r.distribution_unit : regionLabel(r)])
  }, [profile.is_master, masterTargets, data.regions])

  const needsTechnician = profile.is_master && editing && !editing.region_id
  const [technicians, setTechnicians] = useState(null),
    [directoryError, setDirectoryError] = useState(''),
    [retryDirectory, setRetryDirectory] = useState(0)

  useEffect(() => {
    if (!needsTechnician) return
    let active = true
    setTechnicians(null)
    setDirectoryError('')
    rpc(db, 'manage', { action: 'stock_technicians', p: {} })
      .then((list) => {
        if (active) setTechnicians(list)
      })
      .catch((err) => {
        if (active) setDirectoryError(err.message)
      })
    return () => {
      active = false
    }
  }, [db, needsTechnician, retryDirectory])

  const [start, setStart] = useState(''),
    [manualGlove, setManualGlove] = useState(false)
  const detected = /luva.*isolante/i.test(name || '') || /luva.*isolante/i.test(suggested)
  const glove = detected || manualGlove

  const scopedMaterials = useMemo(
    () => data.materials.filter((m) => !profile.is_master || !unit || m.region_id === unit),
    [data.materials, profile.is_master, unit],
  )

  /* ─── 4 Indicadores da Aba Estoque ─── */
  const stockKpis = useMemo(() => {
    const totalRegistered = scopedMaterials.length
    const totalUnits = scopedMaterials.reduce((s, m) => s + Number(m.qty || 0), 0)
    const zeroedCount = scopedMaterials.filter((m) => Number(m.qty || 0) - Number(m.reserved || 0) <= 0).length
    const totalValue =
      scopedMaterials.reduce((s, m) => s + Number(m.qty || 0) * Math.round(Number(m.price || 0) * 100), 0) / 100
    return [
      ['Quantidade de itens cadastrados', totalRegistered.toLocaleString('pt-BR'), Boxes, 'blue'],
      ['Quantidade geral de todos os itens', totalUnits.toLocaleString('pt-BR'), Layers, 'green'],
      ['Itens zerados', zeroedCount.toLocaleString('pt-BR'), AlertOctagon, zeroedCount > 0 ? 'red' : 'green'],
      ['Valor total em R$ de estoque', money(totalValue), Wallet, 'emerald'],
    ]
  }, [scopedMaterials])

  /* ─── Importação de Planilha, Barra de Progresso e Log Detalhado ─── */
  const fileInputRef = useRef(null)
  const [importUnit, setImportUnit] = useState('')
  const [importing, setImporting] = useState(false)
  const [progress, setProgress] = useState({ percent: 0, step: '', done: 0, total: 0 })
  const [importError, setImportError] = useState('')
  const [activeLog, setActiveLog] = useState(null)
  const [savedLogs, setSavedLogs] = useState([])
  const [loadingLogs, setLoadingLogs] = useState(false)
  const [logFilter, setLogFilter] = useState('all')

  const effectiveImportUnit = profile.is_master
    ? importUnit || unit || units[0]?.[0] || ''
    : profile.stock_unit || profile.user_id

  async function loadImportLogs(openAfter = false) {
    setLoadingLogs(true)
    try {
      const list = await rpc(db, 'manage', {
        action: 'import_logs',
        p: profile.is_master && unit ? { region_id: unit } : {},
      })
      if (Array.isArray(list)) {
        setSavedLogs(list)
        if (openAfter && !activeLog && list.length > 0) setActiveLog(list[0])
      }
    } catch {
      // Caso a migração ainda não tenha sido aplicada no banco, mantém os logs da sessão atual
    } finally {
      setLoadingLogs(false)
    }
  }

  function handleDownloadTemplate(prefillCurrent = false) {
    const bytes = buildStockTemplateBytes(prefillCurrent ? scopedMaterials : [])
    const suffix = prefillCurrent ? 'Estoque_Atual_SSMA' : 'Template_Estoque_SSMA'
    triggerXlsxDownload(bytes, `${suffix}_${today()}.xlsx`)
  }

  async function fallbackClientSideImport(parsedRows, targetRegionId, onStep) {
    const normStr = (v) => String(v || '').trim().toLowerCase()
    const cleanCa = (v) => String(v || '').trim().replace(/^0+/, '')
    const localPool = data.materials.filter((m) => m.region_id === targetRegionId)
    const entries = []
    for (let i = 0; i < parsedRows.length; i++) {
      const row = parsedRows[i]
      try {
        const match = localPool.find(
          (m) =>
            Boolean(m.no_ca) === Boolean(row.no_ca) &&
            (row.no_ca || cleanCa(m.ca) === cleanCa(row.ca)) &&
            normStr(m.size) === normStr(row.size) &&
            normStr(m.color) === normStr(row.color) &&
            (row.no_ca ? normStr(m.name) === normStr(row.name) : true),
        )
        if (match) {
          await rpc(db, 'manage', {
            action: 'edit_material',
            p: {
              material_id: match.id,
              revision: match.revision,
              region_id: targetRegionId,
              name: row.name,
              ca: row.ca,
              no_ca: row.no_ca,
              generic_cas: row.generic_cas,
              price: row.price,
              qty: row.qty,
              minimum: row.minimum,
              size: row.size,
              color: row.color,
              insulating_glove: match.insulating_glove,
              glove_start: match.glove_start,
            },
          })
          entries.push({
            line: row.line,
            material: row.name,
            ca: row.no_ca ? 'Sem CA' : row.ca,
            status: 'updated',
            detail: `Material atualizado (Qtd: ${row.qty}, Mín: ${row.minimum}).`,
          })
        } else {
          await rpc(db, 'manage', {
            action: 'material',
            p: {
              id: crypto.randomUUID(),
              ...(profile.is_master ? { master_unit: targetRegionId } : {}),
              name: row.name,
              ca: row.ca,
              no_ca: row.no_ca,
              generic_cas: row.generic_cas,
              price: row.price,
              qty: row.qty,
              minimum: row.minimum,
              size: row.size,
              color: row.color,
            },
          })
          entries.push({
            line: row.line,
            material: row.name,
            ca: row.no_ca ? 'Sem CA' : row.ca,
            status: 'created',
            detail: `Novo material criado (Qtd: ${row.qty}, Mín: ${row.minimum}).`,
          })
        }
      } catch (err) {
        entries.push({
          line: row.line,
          material: row.name,
          ca: row.no_ca ? 'Sem CA' : row.ca,
          status: 'error',
          detail: err.message || 'Falha ao processar item.',
        })
      }
      onStep(i + 1)
    }
    return entries
  }

  async function handleFileSelected(file) {
    if (!file || importing) return
    if (profile.is_master && !effectiveImportUnit) {
      setImportError('Selecione a unidade ou técnico de destino antes de enviar a planilha.')
      return
    }
    setImporting(true)
    setImportError('')
    setProgress({ percent: 8, step: 'Lendo e validando estrutura da planilha…', done: 0, total: 0 })

    try {
      const buffer = await file.arrayBuffer()
      const parsed = await parseStockSpreadsheet(buffer, file.name)
      if (parsed.totalRead === 0) {
        throw new Error('A planilha está vazia. Preencha ao menos uma linha de material abaixo do cabeçalho.')
      }

      const totalToProcess = parsed.rows.length
      setProgress({
        percent: 18,
        step: 'Registrando arquivo temporário para processamento seguro…',
        done: 0,
        total: totalToProcess,
      })

      let stagedFileId = null
      let targetRegion = effectiveImportUnit
      let backendSupported = true

      try {
        const base64Sample = btoa(
          String.fromCharCode(...new Uint8Array(buffer.slice(0, Math.min(buffer.byteLength, 32768)))),
        )
        const staged = await rpc(db, 'manage', {
          action: 'import_stage_file',
          p: {
            region_id: effectiveImportUnit,
            file_name: file.name,
            byte_size: file.size,
            raw_payload: base64Sample,
          },
        })
        stagedFileId = staged?.file_id || null
        if (staged?.region_id) targetRegion = staged.region_id
      } catch (stageErr) {
        if (/Operação desconhecida|Sem permissão/i.test(stageErr.message || '')) {
          if (/Sem permissão/i.test(stageErr.message || '')) throw stageErr
          backendSupported = false
        } else {
          throw stageErr
        }
      }

      const batchEntries = [...parsed.preErrors]
      if (backendSupported && totalToProcess > 0) {
        const BATCH_SIZE = 25
        let processed = 0
        for (let offset = 0; offset < parsed.rows.length; offset += BATCH_SIZE) {
          const chunk = parsed.rows.slice(offset, offset + BATCH_SIZE)
          const res = await rpc(db, 'manage', {
            action: 'import_stock_batch',
            p: { region_id: targetRegion, rows: chunk },
          })
          if (Array.isArray(res?.results)) batchEntries.push(...res.results)
          processed += chunk.length
          const pct = Math.min(90, 22 + Math.round((processed / totalToProcess) * 68))
          setProgress({
            percent: pct,
            step: `Atualizando e cadastrando materiais (${processed} de ${totalToProcess})…`,
            done: processed,
            total: totalToProcess,
          })
        }
      } else if (!backendSupported && totalToProcess > 0) {
        const fbEntries = await fallbackClientSideImport(parsed.rows, targetRegion, (doneCount) => {
          const pct = Math.min(90, 22 + Math.round((doneCount / totalToProcess) * 68))
          setProgress({
            percent: pct,
            step: `Atualizando e cadastrando materiais (${doneCount} de ${totalToProcess})…`,
            done: doneCount,
            total: totalToProcess,
          })
        })
        batchEntries.push(...fbEntries)
      }

      batchEntries.sort((a, b) => (a.line || 0) - (b.line || 0))
      const createdCount = batchEntries.filter((e) => e.status === 'created').length
      const updatedCount = batchEntries.filter((e) => e.status === 'updated').length
      const unchangedCount = batchEntries.filter((e) => e.status === 'unchanged').length
      const errorCount = batchEntries.filter((e) => e.status === 'error').length

      setProgress({
        percent: 96,
        step: 'Excluindo arquivo temporário do banco de dados e gravando log…',
        done: totalToProcess,
        total: totalToProcess,
      })

      let finalLog = {
        id: crypto.randomUUID(),
        actor_name: profile.display_name || 'Usuário',
        region_id: targetRegion,
        unit_name:
          units.find(([id]) => id === targetRegion)?.[1] ||
          regionLabel(data.regions.find((r) => r.id === targetRegion)) ||
          'Estoque autorizado',
        file_name: file.name,
        total_rows: batchEntries.length,
        created_count: createdCount,
        updated_count: updatedCount,
        unchanged_count: unchangedCount,
        error_count: errorCount,
        file_deleted: true,
        entries: batchEntries,
        created_at: new Date().toISOString(),
      }

      if (backendSupported) {
        const saved = await rpc(db, 'manage', {
          action: 'import_finish',
          p: {
            file_id: stagedFileId,
            region_id: targetRegion,
            file_name: file.name,
            total_rows: batchEntries.length,
            created_count: createdCount,
            updated_count: updatedCount,
            unchanged_count: unchangedCount,
            error_count: errorCount,
            entries: batchEntries,
          },
        })
        if (saved?.id) finalLog = saved
      }

      setProgress({
        percent: 100,
        step: 'Importação concluída! Arquivo temporário removido automaticamente do banco.',
        done: totalToProcess,
        total: totalToProcess,
      })

      await refresh?.()
      onChange?.()
      setActiveLog(finalLog)
      setLogFilter('all')
      setSavedLogs((prev) => [finalLog, ...prev.filter((x) => x.id !== finalLog.id)].slice(0, 25))
      setShow('logs')
    } catch (err) {
      setImportError(err.message || 'Não foi possível importar a planilha.')
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = ''
      setImporting(false)
    }
  }

  const materialOptions = scopedMaterials.map((m) => [
    m.id,
    variant(m) + ' · ' + regionLabel(data.regions.find((r) => r.id === m.region_id)),
  ])
  const [order, setOrder] = useState('Relevância')
  const [replenishment, setReplenishment] = useState('Todas')
  const norm = (value) =>
    String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .trim()
      .toLowerCase()
  const term = norm(search)
  const score = (m) =>
    [m.ca, ...(m.generic_cas || []), m.name].some((v) => norm(v) === term)
      ? 0
      : norm(m.name).startsWith(term)
        ? 1
        : 2
  const replenishmentStatus = (m) => {
    const avail = available(m)
    const min = m.minimum || 0
    if (avail < min) return 'Comprar'
    const limit = min > 0 ? min * 1.5 : 10
    if (avail > limit) return 'Acima'
    return 'Ideal'
  }
  const materials = scopedMaterials.filter((m) => {
    const rep = replenishmentStatus(m)
    if (replenishment === 'Comprar' && rep !== 'Comprar') return false
    if (replenishment === 'Não comprar' && rep === 'Comprar') return false
    if (replenishment === 'Ideal' && rep !== 'Ideal') return false
    if (replenishment === 'Acima' && rep !== 'Acima') return false
    return norm([variant(m), m.ca, ...(m.generic_cas || [])].join(' ')).includes(term)
  })
  const totalVal = (m) => available(m) * Number(m.price || 0)
  materials.sort((a, b) => {
    if (order === 'Quantidade crescente') return available(a) - available(b)
    if (order === 'Quantidade decrescente') return available(b) - available(a)
    if (order === 'Menor valor unitário') return Number(a.price || 0) - Number(b.price || 0)
    if (order === 'Maior valor unitário') return Number(b.price || 0) - Number(a.price || 0)
    if (order === 'Menor valor total') return totalVal(a) - totalVal(b)
    if (order === 'Maior valor total') return totalVal(b) - totalVal(a)
    if (order === 'Relevância' && term) return score(a) - score(b)
    return variant(a).localeCompare(variant(b), 'pt-BR', { numeric: true })
  })
  const pages = usePages(materials, search + unit + order + replenishment)

  const filteredLogEntries = useMemo(() => {
    const list = activeLog?.entries || []
    if (logFilter === 'all') return list
    return list.filter((e) => e.status === logFilter)
  }, [activeLog, logFilter])

  return (
    <>
      {/* 4 Novos Indicadores do Estoque */}
      <div className="epi-indicators" role="region" aria-label="Indicadores de estoque">
        {stockKpis.map(([label, value, Icon, tone]) => (
          <div className={'epi-indicator tone-' + tone} key={label}>
            <span className="epi-indicator-icon">
              <Icon size={22} aria-hidden="true" />
            </span>
            <div>
              <span>{label}</span>
              <strong>{value}</strong>
            </div>
          </div>
        ))}
      </div>

      <Panel
        title="Estoque de materiais"
        action={
          <div className="button-group epi-stock-actions">
            <button
              type="button"
              className="btn-green"
              onClick={() => handleDownloadTemplate(false)}
              title="Baixar planilha modelo formatada na cor verde"
            >
              <Download size={16} aria-hidden="true" /> Baixar template (.xlsx)
            </button>
            <button
              type="button"
              className={show === 'import' ? 'primary' : 'secondary'}
              onClick={() => {
                setImportError('')
                open('import')
              }}
            >
              <Upload size={16} aria-hidden="true" /> Importar planilha
            </button>
            <button
              type="button"
              className={show === 'logs' ? 'primary' : 'secondary'}
              onClick={() => {
                if (show === 'logs') setShow('')
                else {
                  setShow('logs')
                  loadImportLogs(true)
                }
              }}
            >
              <ScrollText size={16} aria-hidden="true" /> Log de importação
            </button>
            <button className="secondary" onClick={() => open('lookup')}>
              <ShieldCheck size={16} aria-hidden="true" /> Consultar CA
            </button>
            <button className="secondary" onClick={() => open('entry')}>
              <Plus size={16} aria-hidden="true" /> Registrar entrada
            </button>
            <button className="primary" onClick={() => open('new')}>
              <CirclePlus size={16} aria-hidden="true" /> Cadastrar material
            </button>
          </div>
        }
      >
        {/* Painel de Importação de Planilha com Barra de Carregamento */}
        {show === 'import' && (
          <section className="stock-import-box" aria-label="Importar planilha de estoque">
            <div className="stock-import-header">
              <div>
                <h3>
                  <FileSpreadsheet size={18} aria-hidden="true" /> Atualizar ou cadastrar estoque via planilha
                </h3>
                <p>
                  Colunas do template: <strong>Nome do material</strong>, <strong>CA principal</strong>,{' '}
                  <strong>CA genérico 1</strong>, <strong>CA genérico 2</strong>, <strong>CA genérico 3</strong>,{' '}
                  <strong>Valor unitário (R$)</strong>, <strong>Quantidade</strong>, <strong>Quantidade mínima</strong>,{' '}
                  <strong>Tamanho / numeração</strong> e <strong>Cor</strong>. Itens existentes são atualizados sem
                  duplicar, novos itens são criados e o arquivo enviado é excluído automaticamente do banco ao concluir.
                </p>
              </div>
              <div className="button-group">
                <button type="button" className="btn-green-outline" onClick={() => handleDownloadTemplate(false)}>
                  <Download size={15} aria-hidden="true" /> Template vazio (.xlsx)
                </button>
                {scopedMaterials.length > 0 && (
                  <button type="button" className="btn-green-outline" onClick={() => handleDownloadTemplate(true)}>
                    <FileSpreadsheet size={15} aria-hidden="true" /> Baixar meu estoque atual (.xlsx)
                  </button>
                )}
              </div>
            </div>

            <div className="stock-import-controls">
              {profile.is_master ? (
                <Select
                  label="Estoque de destino da importação"
                  value={effectiveImportUnit}
                  onChange={(e) => setImportUnit(e.target.value)}
                  options={units}
                  placeholder="Selecione a unidade ou técnico"
                  required
                />
              ) : (
                <div className="stock-scope-lock">
                  <ShieldCheck size={16} aria-hidden="true" />
                  <span>
                    Estoque isolado vinculado ao seu perfil:{' '}
                    <strong>
                      {regionLabel(data.regions.find((r) => r.id === (profile.stock_unit || profile.user_id))) ||
                        'Estoque de ' + profile.display_name}
                    </strong>{' '}
                    (visível apenas com permissão habilitada pelo Admin Master)
                  </span>
                </div>
              )}

              <label
                className={'stock-dropzone' + (importing ? ' is-busy' : '')}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault()
                  const f = e.dataTransfer?.files?.[0]
                  if (f) handleFileSelected(f)
                }}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
                  disabled={importing}
                  onChange={(e) => handleFileSelected(e.target.files?.[0])}
                />
                <Upload size={24} aria-hidden="true" />
                <div>
                  <strong>{importing ? 'Processando planilha…' : 'Clique para selecionar ou arraste a planilha (.xlsx)'}</strong>
                  <small>Após atualizar os itens, o arquivo da planilha é apagado automaticamente do banco de dados.</small>
                </div>
              </label>
            </div>

            {importing && (
              <div className="stock-progress-card" role="status" aria-live="polite">
                <div className="stock-progress-top">
                  <strong>{progress.step}</strong>
                  <span>{progress.percent}%</span>
                </div>
                <div
                  className="stock-progress-track"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={progress.percent}
                >
                  <div className="stock-progress-fill" style={{ width: progress.percent + '%' }} />
                </div>
                {progress.total > 0 && (
                  <small>
                    Itens processados: {progress.done} de {progress.total}
                  </small>
                )}
              </div>
            )}

            {importError && (
              <p role="alert" className="form-error">
                {importError}
              </p>
            )}
          </section>
        )}

        {/* Painel de Logs Detalhados da Importação */}
        {show === 'logs' && (
          <section className="stock-log-box" aria-label="Log de importação de estoque">
            <header className="stock-log-header">
              <div>
                <h3>
                  <ScrollText size={18} aria-hidden="true" /> Log detalhado de importação de estoque
                </h3>
                <small>Histórico de atualizações, novos cadastros, avisos, erros por linha e confirmação de exclusão do arquivo.</small>
              </div>
              <div className="button-group">
                <button type="button" className="secondary btn-sm" onClick={() => loadImportLogs(true)} disabled={loadingLogs}>
                  Atualizar logs
                </button>
                <button type="button" className="secondary btn-sm" onClick={() => setShow('')}>
                  <X size={14} aria-hidden="true" /> Fechar log
                </button>
              </div>
            </header>

            {savedLogs.length > 1 && (
              <div className="epi-filters" style={{ marginTop: 8 }}>
                <Select
                  label="Selecionar execução"
                  value={activeLog?.id || ''}
                  onChange={(e) => {
                    const chosen = savedLogs.find((l) => l.id === e.target.value)
                    if (chosen) setActiveLog(chosen)
                  }}
                  options={savedLogs.map((l) => [
                    l.id,
                    `${stamp(l.created_at)} · ${l.file_name} · ${l.unit_name || 'Estoque'} (${l.created_count} novos, ${l.updated_count} atualizados, ${l.error_count} erros)`,
                  ])}
                />
              </div>
            )}

            {activeLog ? (
              <>
                <div className="stock-log-summary">
                  <span className="stock-log-pill neutral">
                    Total lido: <strong>{activeLog.total_rows}</strong>
                  </span>
                  <button
                    type="button"
                    className={'stock-log-pill green' + (logFilter === 'created' ? ' active' : '')}
                    onClick={() => setLogFilter(logFilter === 'created' ? 'all' : 'created')}
                  >
                    <CheckCircle2 size={14} /> Criados: <strong>{activeLog.created_count}</strong>
                  </button>
                  <button
                    type="button"
                    className={'stock-log-pill blue' + (logFilter === 'updated' ? ' active' : '')}
                    onClick={() => setLogFilter(logFilter === 'updated' ? 'all' : 'updated')}
                  >
                    Atualizados: <strong>{activeLog.updated_count}</strong>
                  </button>
                  <button
                    type="button"
                    className={'stock-log-pill gray' + (logFilter === 'unchanged' ? ' active' : '')}
                    onClick={() => setLogFilter(logFilter === 'unchanged' ? 'all' : 'unchanged')}
                  >
                    Inalterados: <strong>{activeLog.unchanged_count}</strong>
                  </button>
                  <button
                    type="button"
                    className={'stock-log-pill red' + (logFilter === 'error' ? ' active' : '')}
                    onClick={() => setLogFilter(logFilter === 'error' ? 'all' : 'error')}
                  >
                    <XCircle size={14} /> Erros: <strong>{activeLog.error_count}</strong>
                  </button>
                  {activeLog.file_deleted && (
                    <span className="stock-log-pill file-purged">
                      <Info size={14} /> Arquivo "{activeLog.file_name}" deletado automaticamente do banco
                    </span>
                  )}
                </div>

                <div className="stock-log-table-wrap">
                  <Table
                    headers={['Linha', 'Material', 'CA', 'Resultado', 'Informação detalhada']}
                    rows={filteredLogEntries.map((item, idx) => [
                      <span className="num-cell">{item.line || idx + 1}</span>,
                      <strong className="material-strong">{item.material}</strong>,
                      <span className="ca-pill">{item.ca || '—'}</span>,
                      <span
                        className={
                          'badge ' +
                          (item.status === 'created'
                            ? 'green'
                            : item.status === 'updated'
                              ? 'blue'
                              : item.status === 'error'
                                ? 'red'
                                : 'gray')
                        }
                      >
                        {item.status === 'created'
                          ? 'Criado'
                          : item.status === 'updated'
                            ? 'Atualizado'
                            : item.status === 'error'
                              ? 'Erro'
                              : 'Sem alteração'}
                      </span>,
                      item.detail,
                    ])}
                    empty="Nenhum registro para este filtro no log."
                  />
                </div>
              </>
            ) : (
              <p className="epi-empty">
                {loadingLogs
                  ? 'Carregando histórico de logs…'
                  : 'Nenhuma importação realizada ainda para este estoque. Use "Importar planilha" para atualizar seus materiais.'}
              </p>
            )}
          </section>
        )}

        {show === 'lookup' && (
          <div className="ca-search">
            <Field
              label="Número do CA"
              type="search"
              inputMode="numeric"
              maxLength={70}
              value={ca}
              onChange={(e) => changeCa(e.target.value)}
            />
            <CaResult result={lookup} index={fichaIndex} onSelect={setFicha} onRegister={() => setShow('new')} />
            {sheet && (
              <CaExpiryEditor
                key={[ca, sheet.sheet_key, sheet.validade_manual].join('/')}
                sheet={sheet}
                onSave={async (date) => {
                  await save('ca_expiry', {
                    ca,
                    sheet_key: sheet.sheet_key,
                    previous_ca_expiry: sheet.validade_manual,
                    ca_expiry: date,
                  })
                  lookup.retry()
                }}
              />
            )}
          </div>
        )}
        {(editing || show === 'delete') && (
          <h3 ref={formHeading} tabIndex={-1}>
            {editing ? 'Editar material' : 'Excluir material'} · {variant(selected)}
          </h3>
        )}
        {show === 'delete' && selected.reserved > 0 && (
          <div className="notice" role="status">
            <p>Este material tem reservas. Conclua ou cancele os pedidos antes de excluí-lo.</p>
            <button type="button" className="secondary" onClick={() => setShow('')}>
              Fechar
            </button>
          </div>
        )}
        {show === 'delete' && !selected.reserved && (
          <ActionForm
            key={selected.id}
            submit="Confirmar exclusão"
            onSave={() => save('delete_material', { material_id: selected.id, revision: selected.revision })}
            onDone={() => setShow('')}
          >
            <p>O material será retirado do estoque. O histórico de movimentações e entregas será preservado.</p>
            {selected.qty > 0 && <p>Baixa de {selected.qty} unidade(s) no estoque.</p>}
            <button type="button" className="secondary" onClick={() => setShow('')}>
              Cancelar
            </button>
          </ActionForm>
        )}
        {(show === 'new' || editing) && (
          <ActionForm
            key={editing?.id || 'new'}
            submit={editing ? 'Salvar alterações' : 'Salvar material'}
            onSave={(p) =>
              save(editing ? 'edit_material' : 'material', {
                ...p,
                ...(editing && {
                  material_id: editing.id,
                  revision: editing.revision,
                  qty: p.qty || 0,
                  minimum: p.minimum || 0,
                  price: p.price || 0,
                }),
                generic_cas: noCA ? [] : [p.generic1, p.generic2, p.generic3].filter(Boolean),
                insulating_glove: glove,
                glove_start: glove ? start : null,
                no_ca: noCA,
                ...(!noCA && sheet && { ca_sheet_key: sheet.sheet_key }),
                ...(p.ca_expiry && { previous_ca_expiry: sheet?.validade_manual }),
              })
            }
            onDone={() => {
              setNoCA(false)
              setShow('')
            }}
          >
            <Field
              label="Nome do material"
              name="name"
              value={name ?? suggested.slice(0, 200)}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={200}
            />
            <Field
              label="CA principal"
              name="ca"
              value={noCA ? '' : ca}
              onChange={(e) => changeCa(e.target.value)}
              inputMode="numeric"
              required={!noCA}
              disabled={noCA}
              maxLength={70}
            />
            <label className="epi-check">
              <input type="checkbox" checked={noCA} onChange={(e) => setNoCA(e.target.checked)} />
              Material sem CA
            </label>
            {!noCA &&
              [1, 2, 3].map((n) => (
                <Field
                  key={n}
                  label={'CA genérico ' + n}
                  name={'generic' + n}
                  inputMode="numeric"
                  pattern="[0-9]+"
                  maxLength={70}
                  defaultValue={editing?.generic_cas?.[n - 1] || ''}
                />
              ))}
            {!noCA && <CaResult result={lookup} index={fichaIndex} onSelect={setFicha} />}
            <PriceField label="Valor unitário (R$)" initialValue={editing?.price} />
            <Field label="Quantidade" name="qty" {...numberProps} min={editing?.reserved || 0} defaultValue={editing?.qty} />
            {sheet && !noCA && (
              <CaExpiryEditor key={[ca, sheet.sheet_key, sheet.validade_manual].join('/')} sheet={sheet} />
            )}
            <label className="epi-check">
              <input
                type="checkbox"
                checked={glove}
                disabled={detected}
                onChange={(e) => setManualGlove(e.target.checked)}
              />
              Luva isolante
            </label>
            {glove ? (
              <>
                <Field
                  label="Data inicial do certificado ou ensaio elétrico"
                  type="date"
                  value={start}
                  required
                  onChange={(e) => setStart(e.target.value)}
                />
                <Field
                  label="Número da luva esquerda"
                  name="glove_left_number"
                  maxLength={100}
                  defaultValue={editing?.glove_left_number || ''}
                />
                <Field
                  label="Número da luva direita"
                  name="glove_right_number"
                  maxLength={100}
                  defaultValue={editing?.glove_right_number || ''}
                />
                {start && <p>Vencimento da luva: {dateLabel(after365(start))}</p>}
              </>
            ) : (
              <details className="material-lot-expiry">
                <summary>Validade do lote (opcional)</summary>
                <Field label="Vencimento do material em estoque" name="expiry" type="date" defaultValue={editing?.expiry} />
              </details>
            )}
            <Field label="Quantidade mínima" name="minimum" {...numberProps} defaultValue={editing?.minimum} />
            <Field label="Tamanho / numeração" name="size" defaultValue={editing?.size} />
            <Select
              label="Cor"
              name="color"
              defaultValue={editing?.color}
              placeholder="Selecione a cor"
              options={[
                ...materialColors,
                ...(editing?.color && !materialColors.includes(editing.color) ? [editing.color] : []),
              ]}
            />
            {profile.is_master && show === 'new' && (
              <Select label="Unidade ou estoque do material" name="master_unit" defaultValue={unit} required options={units} />
            )}
            {needsTechnician &&
              (directoryError ? (
                <p role="alert">
                  {directoryError}{' '}
                  <button type="button" className="secondary" onClick={() => setRetryDirectory((n) => n + 1)}>
                    Tentar novamente
                  </button>
                </p>
              ) : technicians?.length === 1 ? (
                <>
                  <p>Estoque do técnico responsável · {technicians[0].name}</p>
                  <input type="hidden" name="technician_id" value={technicians[0].id} />
                </>
              ) : (
                <Select
                  label="Técnico responsável pelo estoque"
                  name="technician_id"
                  options={(technicians || []).map((t) => [t.id, t.name])}
                  required
                />
              ))}
            {needsTechnician && technicians?.length === 0 && (
              <p role="status">Conceda a permissão de estoque a um técnico em Gestão de técnicos.</p>
            )}
            {editing && (
              <button className="secondary" type="button" onClick={() => setShow('')}>
                Cancelar edição
              </button>
            )}
          </ActionForm>
        )}
        {show === 'entry' && (
          <ActionForm submit="Confirmar entrada" onSave={(p) => save('entry', p)} onDone={() => setShow('')}>
            <Select label="Material" name="material_id" options={materialOptions} required />
            <Field label="Quantidade recebida" name="qty" type="number" min={1} required />
            <PriceField label="Valor unitário da entrada (R$)" placeholder="Usar o custo atual" />
          </ActionForm>
        )}
        <div className="epi-filters epi-stock-filters">
          <Select
            label="Filtrar por reposição"
            value={replenishment}
            onChange={(e) => setReplenishment(e.target.value)}
            options={[['Todas', 'Todas as reposições'], 'Comprar', 'Não comprar', 'Ideal', 'Acima']}
          />
          <Select
            label="Ordenar materiais"
            value={order}
            onChange={(e) => setOrder(e.target.value || 'Relevância')}
            options={[
              'Relevância',
              'Ordem alfabética',
              'Quantidade crescente',
              'Quantidade decrescente',
              'Menor valor unitário',
              'Maior valor unitário',
              'Menor valor total',
              'Maior valor total',
            ]}
          />
          {profile.is_master && (
            <Select
              label="Filtrar material por estoque / unidade"
              placeholder="Todos os estoques"
              value={unit}
              onChange={(e) => setUnit(e.target.value)}
              options={units}
            />
          )}
          <Field
            label="Buscar material ou CA"
            type="search"
            icon={<Search size={15} aria-hidden="true" />}
            placeholder="Buscar..."
            value={search}
            onChange={(e) => {
              setSearch(e.target.value)
              if (!show) setFicha(0)
            }}
          />
        </div>
        {stockCa && (
          <CaResult
            result={lookup}
            index={fichaIndex}
            onSelect={setFicha}
            onRegister={() => {
              setCa(stockCa)
              setName(null)
              setNoCA(false)
              setShow('new')
            }}
          />
        )}
        <Table
          headers={[
            'Material / grade',
            'CA',
            'Estoque',
            'Disponível',
            'Mínimo',
            'Reposição',
            'Valor unitário',
            'Validade',
            'Ações',
          ]}
          rows={pages.items.map((m) => {
            const rep = replenishmentStatus(m)
            return [
              <strong className="material-strong">{variant(m)}</strong>,
              m.no_ca ? <span className="badge red">Sem CA</span> : m.ca,
              regionLabel(data.regions.find((r) => r.id === m.region_id)),
              available(m),
              m.minimum,
              <span className={'badge badge-icon ' + (rep === 'Comprar' ? 'red' : rep === 'Acima' ? 'blue' : 'green')}>
                {rep === 'Comprar' ? (
                  <ShoppingCart size={13} aria-hidden="true" />
                ) : rep === 'Acima' ? (
                  <TrendingUp size={13} aria-hidden="true" />
                ) : (
                  <CircleCheck size={13} aria-hidden="true" />
                )}
                <span>{rep}</span>
              </span>,
              money(m.price),
              <div>
                {m.insulating_glove && (
                  <details>
                    <summary>{m.glove_start ? 'Atualizar ensaio' : 'Informar início'}</summary>
                    <ActionForm
                      submit="Salvar data"
                      onSave={(p) => save('glove_date', { ...p, material_id: m.id, previous: m.glove_start })}
                    >
                      <Field label="Data do certificado ou ensaio" name="glove_start" type="date" required />
                    </ActionForm>
                  </details>
                )}
                {m.ca_expiry && (
                  <div>
                    <span className={!m.expiry && !m.insulating_glove ? 'sr-only' : ''}>CA · </span>
                    {m.ca_expiry}
                  </div>
                )}
                {m.expiry && (
                  <div className={m.expiry < today() ? 'red-text' : ''}>
                    {m.insulating_glove ? 'Ensaio' : 'Lote'} · {dateLabel(m.expiry)}
                  </div>
                )}
                {!m.ca_expiry && !m.expiry && '—'}
              </div>,
              <div className="table-icon-actions">
                <button
                  className="icon-action"
                  title="Editar"
                  aria-label={'Editar ' + variant(m)}
                  onClick={() => selectMaterial(m, 'edit')}
                >
                  <Pencil size={15} aria-hidden="true" />
                </button>
                <button
                  className="icon-action danger"
                  title="Excluir"
                  aria-label={'Excluir ' + variant(m)}
                  onClick={() => selectMaterial(m, 'delete')}
                >
                  <Trash2 size={15} aria-hidden="true" />
                </button>
              </div>,
            ]
          })}
          empty="Nenhum material encontrado neste estoque."
        />
        {pages.controls}
      </Panel>
    </>
  )
}
