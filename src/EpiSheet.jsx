import { Skeleton } from './Skeleton'
import React, { useEffect, useRef, useState } from 'react'
import { Field, Panel, Select, rpc } from './EpiShared'
import { ReplacementAlert } from './EpiIndicators'
import { defaultSettings, identityFields, SheetDocument } from './EpiSheetDocument'
import { SheetMaterials, deliveryReasons } from './SheetMaterials'
import { StockImpactNotice } from './EpiOperations'
import { stamp, variant } from './epiData'
import { Search, UserCheck, Printer, FileDown, X, FileText, User, Trash2, RotateCcw } from 'lucide-react'

async function squareLogo(file) {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type))
    throw Error('Escolha uma imagem PNG, JPEG ou WebP.')
  if (file.size > 10 * 1024 * 1024) throw Error('Escolha uma imagem de até 10 MB.')
  const image = await createImageBitmap(file)
  try {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 256
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, 256, 256)
    const scale = 256 / Math.max(image.width, image.height)
    const w = image.width * scale,
      h = image.height * scale
    ctx.drawImage(image, (256 - w) / 2, (256 - h) / 2, w, h)
    return canvas.toDataURL('image/png')
  } finally {
    image.close()
  }
}

/**
 * Modal exclusivo de "Pré-visualização da Ficha de EPI" com opção de Impressão e Salvar PDF
 * Acionado ao clicar em "Abrir ficha de EPI" no card da solicitação.
 */
export function RequestSheetPreview({ db, request, onClose }) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [docData, setDocData] = useState(null)

  useEffect(() => {
    let active = true
    setLoading(true)
    setError('')

    rpc(db, 'sheet', {
      action: 'context',
      p: { employee_id: request.employee_id, request_id: request.id },
    })
      .then((res) => {
        if (!active) return
        if (res?.issued) {
          setDocData({
            snapshot: res.issued.snapshot,
            settings: res.issued.settings,
            number: res.issued.number,
            issuedAt: res.issued.issued_at,
          })
        } else if (res?.snapshot) {
          const settings = res.draft?.settings || defaultSettings(res.snapshot, res.template)
          setDocData({
            snapshot: res.snapshot,
            settings,
            number: null,
            issuedAt: request.closed_at || request.created_at,
          })
        }
      })
      .catch((err) => {
        if (!active) return
        // Fallback local caso o colaborador tenha sido desligado/removido, garantindo a pré-visualização
        const fallbackItems = (request.items || []).map((it, idx) => ({
          key: `${request.id}/${it.material_id || idx}`,
          date: String(request.closed_at || request.created_at || '').slice(0, 10),
          ca: it.ca || '',
          equipment: variant(it),
          qty: it.qty,
          reason: it.reason || 'Inicial',
        }))
        const fallbackSnapshot = {
          name: request.employee || '',
          unit: request.project || '',
          job: request.job || '',
          company: '',
          sector: '',
          cnpj: '',
          registration: '',
          cpf: '',
          items: fallbackItems,
        }
        setDocData({
          snapshot: fallbackSnapshot,
          settings: defaultSettings(fallbackSnapshot, null),
          number: null,
          issuedAt: request.closed_at || request.created_at,
        })
        if (!fallbackItems.length) setError(err.message || 'Não foi possível carregar a ficha.')
      })
      .finally(() => {
        if (active) setLoading(false)
      })

    return () => {
      active = false
    }
  }, [db, request])

  return (
    <div
      className="epi-sheet-overlay"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className="epi-sheet-modal epi-preview-only-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Pré-visualização da Ficha de EPI"
      >
        <header className="epi-sheet-modal-header">
          <div className="fepi-preview-title" style={{ textTransform: 'none', fontSize: 16 }}>
            <FileText size={19} aria-hidden="true" />
            <div>
              <h2 style={{ margin: 0 }}>Pré-visualização da Ficha de EPI</h2>
              <small>
                {request.employee} · {request.project}
                {docData?.number ? ` · Ficha Nº ${docData.number}` : ''}
              </small>
            </div>
          </div>
          <div className="button-group">
            <button
              type="button"
              className="secondary epi-sheet-close-btn"
              disabled={loading || !docData}
              onClick={() => window.print()}
            >
              <Printer size={16} aria-hidden="true" /> Imprimir
            </button>
            <button
              type="button"
              className="primary epi-sheet-close-btn"
              disabled={loading || !docData}
              onClick={() => window.print()}
              title="Selecione 'Salvar como PDF' na janela de impressão"
            >
              <FileDown size={16} aria-hidden="true" /> Salvar PDF
            </button>
            <button
              type="button"
              className="secondary epi-sheet-close-btn"
              onClick={onClose}
              aria-label="Fechar pré-visualização"
            >
              <X size={18} aria-hidden="true" /> Fechar
            </button>
          </div>
        </header>

        <div className="epi-sheet-modal-content epi-preview-only-body">
          {loading ? (
            <Skeleton label="Carregando Pré-visualização da Ficha de EPI…" />
          ) : error && !docData ? (
            <div className="notice error" role="alert">
              {error}
            </div>
          ) : (
            docData && (
              <div className="fepi-document-container fepi-document-standalone">
                <SheetDocument
                  snapshot={docData.snapshot}
                  settings={docData.settings}
                  number={docData.number}
                  issuedAt={docData.issuedAt}
                />
              </div>
            )
          )}
        </div>
      </div>
    </div>
  )
}

function EmployeeSheets({ db, id, request, profile, delivered, onIssued, archiveId, onArchiveDeleted }) {
  const [context, setContext] = useState(null),
    [doc, setDoc] = useState(null),
    [settings, setSettings] = useState(null)
  const [mode, setMode] = useState('new'),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  const [confirm, setConfirm] = useState(false),
    [template, setTemplate] = useState(false),
    [reload, setReload] = useState(0)
  const [items, setItems] = useState([])
  const [itemQuantities, setItemQuantities] = useState({})
  const [message, setMessage] = useState('')
  const [removed, setRemoved] = useState([])
  const newId = useRef(crypto.randomUUID())
  const lock = useRef(false)
  const api = (action, p = {}) => rpc(db, 'sheet', { action, p: { employee_id: id, ...p } })

  useEffect(() => {
    let current = true
    setBusy(true)
    setError('')
    rpc(db, 'sheet', { action: archiveId ? 'open' : 'context', p: { employee_id: id, id: archiveId, request_id: request?.id } })
      .then(async (value) => {
        if (!current) return
        if (archiveId || value.issued) {
          value = value.issued || value
          const ctx = archiveId ? {} : await rpc(db, 'sheet', { action: 'context', p: { employee_id: id } })
          if (!current) return
          setContext({ ...ctx, sheets: [value, ...(ctx.sheets || []).filter((s) => s.id !== value.id)] })
          view(value)
          return
        }
        setContext(value)
        setDoc(null)
        setMode('new')
        setItems(value.draft?.items || [])
        setRemoved(value.draft?.removed || [])
        setItemQuantities({})
        setConfirm(false)
        setTemplate(false)
        newId.current = crypto.randomUUID()
        setSettings(value.draft?.settings || defaultSettings(value.snapshot, value.template))
      })
      .catch((e) => {
        if (current) setError(e.message)
      })
      .finally(() => {
        if (current) setBusy(false)
      })
    return () => {
      current = false
    }
  }, [db, id, reload, archiveId, request?.id, request?.status])

  async function run(fn) {
    if (lock.current) return
    lock.current = true
    setBusy(true)
    setError('')
    try {
      await fn()
    } catch (e) {
      setError(e.message || 'Não foi possível concluir.')
    } finally {
      lock.current = false
      setBusy(false)
    }
  }

  function view(value) {
    setItems([])
    setRemoved([])
    setItemQuantities(
      Object.fromEntries((value?.snapshot?.items || []).map((i) => [i.key, String(i.qty)])),
    )
    setDoc(value)
    setSettings(value.settings)
    setMode('view')
    setConfirm(false)
    setTemplate(false)
  }

  function startEditing() {
    if (!doc) return
    setItems([])
    setRemoved([])
    setItemQuantities(
      Object.fromEntries((doc.snapshot?.items || []).map((i) => [i.key, String(i.qty)])),
    )
    setConfirm(false)
    setMessage('')
    setMode('edit')
  }

  function save(draft = false) {
    return run(async () => {
      const parsedItemQuantities = {}
      if (mode === 'edit' && doc?.snapshot?.items) {
        for (const it of doc.snapshot.items) {
          if (removed.includes(it.key)) continue
          const qVal = Number(itemQuantities[it.key] ?? it.qty)
          if (!Number.isInteger(qVal) || qVal < 1) {
            throw new Error(`Informe uma quantidade inteira válida (mínimo 1) para ${it.equipment}.`)
          }
          parsedItemQuantities[it.key] = qVal
        }
      }

      const value = await api(draft ? 'draft' : mode === 'new' ? 'issue' : 'edit', {
        id: doc?.id || newId.current,
        revision: doc?.revision,
        version: context.version,
        settings,
        save_template: template,
        ...(mode === 'new' && !request
          ? { new_items: items }
          : { document_items: items, removed, item_quantities: parsedItemQuantities }),
        request_id: mode === 'new' ? request?.id : undefined,
      })
      if (draft && !value.issued) {
        setContext(value)
        setMessage('Rascunho salvo.')
        return
      }
      const saved = value.issued || value
      // Atualiza também o saldo disponível dos materiais no contexto após edição/emissão
      const freshCtx = !archiveId ? await rpc(db, 'sheet', { action: 'context', p: { employee_id: id } }).catch(() => null) : null
      setContext((previous) => ({
        ...(freshCtx || previous),
        sheets: [saved, ...((freshCtx?.sheets || previous.sheets || []).filter((s) => s.id !== saved.id))],
      }))
      view(saved)
      setMessage(
        mode === 'edit'
          ? 'Ficha alterada com sucesso e saldo do estoque sincronizado.'
          : 'Ficha emitida e saldo do estoque atualizado.',
      )
      onIssued?.()
    })
  }

  const field = (key, value) => setSettings((current) => ({ ...current, [key]: value }))
  const baseSnapshot = doc?.snapshot || context?.snapshot
  const keptSnapshotItems = (baseSnapshot?.items || [])
    .filter((i) => !removed.includes(i.key))
    .map((i) => ({
      ...i,
      qty: Number(itemQuantities[i.key] ?? i.qty) || i.qty,
    }))

  const addedPreviewItems = items.map((it, idx) => {
    const mat = (context?.materials || []).find((m) => m.id === it.id)
    return {
      key: 'draft-' + (it.id || idx),
      date: new Date().toISOString().slice(0, 10),
      ca: mat?.ca || '',
      equipment: mat?.name || 'Material',
      qty: it.qty,
      reason: it.reason,
    }
  })

  const liveItems =
    mode === 'new' && !request
      ? addedPreviewItems
      : [...keptSnapshotItems, ...(mode === 'edit' || request ? addedPreviewItems : [])]

  const effectiveSnapshot = baseSnapshot && {
    ...baseSnapshot,
    items: liveItems,
  }
  const effectiveReasons = {
    ...(settings?.reasons || {}),
    ...Object.fromEntries(addedPreviewItems.map((i) => [i.key, i.reason])),
  }
  const effectiveSettings = settings && {
    ...settings,
    reasons: effectiveReasons,
  }

  return (
    <div className="fepi-workspace">
      {message && (
        <p className="epi-success" role="status">
          {message}
        </p>
      )}
      {error && (
        <div role="alert" className="notice error">
          {error}{' '}
          <button className="secondary" disabled={busy} onClick={() => setReload((n) => n + 1)}>
            Recarregar fichas
          </button>
        </div>
      )}
      {busy && !context && <Skeleton label="Carregando fichas…" />}

      {context && settings && (
        <div className="fepi-split-container">
          {/* Coluna Esquerda: Formulários e Controles */}
          <div className="fepi-form-column">
            <Panel title="Fichas emitidas">
              <div className="epi-filters">
                {!archiveId && !request && (
                  <Select
                    label="Abrir ficha"
                    options={context.sheets.map((s) => [s.id, 'Nº ' + s.number + ' · ' + stamp(s.issued_at)])}
                    placeholder="Nova ficha"
                    value={doc?.id || ''}
                    disabled={busy}
                    onChange={(e) => {
                      const key = e.target.value
                      setMessage('')
                      if (key) run(async () => view(await api('open', { id: key })))
                      else setReload((n) => n + 1)
                    }}
                  />
                )}
                {mode === 'view' && (
                  <div className="button-group" style={{ flexWrap: 'wrap' }}>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={Boolean(doc?.signed)}
                      aria-label="Marcar ficha aberta como assinada"
                      disabled={busy}
                      className={'epi-sign-switch' + (doc?.signed ? ' is-signed' : '')}
                      onClick={() =>
                        run(async () => {
                          const updated = await api('toggle_signed', { id: doc.id, signed: !doc?.signed })
                          setDoc(updated)
                          setContext((prev) =>
                            prev
                              ? {
                                  ...prev,
                                  sheets: (prev.sheets || []).map((s) =>
                                    s.id === updated.id
                                      ? { ...s, signed: updated.signed, signed_at: updated.signed_at }
                                      : s,
                                  ),
                                }
                              : prev,
                          )
                          onIssued?.()
                        })
                      }
                    >
                      <span className="epi-switch-track" aria-hidden="true">
                        <span className="epi-switch-thumb" />
                      </span>
                      <span className="epi-switch-label">Assinada</span>
                    </button>
                    <button className="secondary" disabled={busy} onClick={startEditing}>
                      Editar ficha
                    </button>
                    <button className="btn-soft-danger btn-sm" disabled={busy} onClick={() => setConfirm(true)}>
                      Excluir ficha
                    </button>
                    <button className="primary" disabled={busy} onClick={() => window.print()}>
                      <Printer size={15} /> Imprimir / PDF
                    </button>
                  </div>
                )}
              </div>
              {doc?.expires_at && <p className="epi-help">Exclusão programada para {stamp(doc.expires_at)}.</p>}
              {confirm && (
                <div className="epi-request-remove-box" style={{ marginTop: 12 }}>
                  <StockImpactNotice context="excluída" />
                  <p style={{ margin: '8px 0 12px' }}>
                    Excluir a ficha nº <strong>{doc.number}</strong>? Todos os materiais entregues retornarão para o
                    saldo do estoque e os lançamentos financeiros serão estornados.
                  </p>
                  <div className="button-group">
                    <button className="secondary" disabled={busy} onClick={() => setConfirm(false)}>
                      Cancelar
                    </button>
                    <button
                      className="primary"
                      disabled={busy}
                      onClick={() =>
                        run(async () => {
                          await api('delete', { id: doc.id, revision: doc.revision })
                          setMessage('Ficha excluída e materiais devolvidos ao estoque.')
                          onIssued?.()
                          if (archiveId) onArchiveDeleted()
                          else setReload((n) => n + 1)
                        })
                      }
                    >
                      Confirmar exclusão
                    </button>
                  </div>
                </div>
              )}
            </Panel>

            <ReplacementAlert requests={delivered} />

            {mode !== 'view' && (
              <Panel
                title={
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
                    <span>{mode === 'edit' ? 'Editar ficha nº ' + doc.number : 'Nova ficha de EPI'}</span>
                    {mode === 'new' && <span className="badge blue">Modo Rascunho</span>}
                  </div>
                }
              >
                <form
                  className="fepi-editor"
                  onSubmit={(e) => {
                    e.preventDefault()
                    save()
                  }}
                >
                  <fieldset disabled={busy}>
                    {mode === 'edit' && <StockImpactNotice context="editada ou tiver itens alterados ou excluídos" />}

                    {/* Edição direta dos itens já pertencentes à ficha (alterar quantidade, motivo ou excluir item) */}
                    {(request || mode === 'edit') && (baseSnapshot?.items?.length || 0) > 0 && (
                      <div className="epi-edit-items-list" style={{ marginBottom: 16 }}>
                        <h4>Itens atuais da ficha (altere a quantidade ou exclua itens)</h4>
                        {baseSnapshot.items.map((i) => {
                          const isRemoved = removed.includes(i.key)
                          const curQty = Number(itemQuantities[i.key] ?? i.qty)
                          const diff = isRemoved ? -i.qty : curQty - i.qty
                          return (
                            <div key={i.key} className={'epi-edit-item-row' + (isRemoved ? ' is-removed' : '')}>
                              <div className="epi-edit-item-info">
                                <strong>{i.equipment}</strong>
                                <small>
                                  {i.ca ? `CA ${i.ca}` : 'Sem CA'} · Qtd. original: {i.qty}
                                  {diff !== 0 && (
                                    <span className={'epi-stock-delta ' + (diff < 0 ? 'return' : 'consume')}>
                                      {diff < 0
                                        ? ` (+${Math.abs(diff)} retorna ao estoque)`
                                        : ` (-${diff} sai do estoque)`}
                                    </span>
                                  )}
                                </small>
                              </div>
                              <div className="epi-edit-item-controls">
                                {!isRemoved && (
                                  <>
                                    <label className="epi-inline-qty">
                                      <span>Qtd.</span>
                                      <input
                                        type="number"
                                        min={1}
                                        step={1}
                                        required
                                        value={itemQuantities[i.key] ?? i.qty}
                                        onChange={(e) =>
                                          setItemQuantities((prev) => ({ ...prev, [i.key]: e.target.value }))
                                        }
                                      />
                                    </label>
                                    <select
                                      aria-label={'Motivo · ' + i.equipment}
                                      className="epi-inline-reason"
                                      value={settings.reasons[i.key] || i.reason || ''}
                                      onChange={(e) =>
                                        field('reasons', { ...settings.reasons, [i.key]: e.target.value })
                                      }
                                    >
                                      <option value="">Motivo…</option>
                                      {[
                                        ...new Set([
                                          ...deliveryReasons,
                                          ...(settings.reasons[i.key] ? [settings.reasons[i.key]] : []),
                                        ]),
                                      ].map((r) => (
                                        <option key={r} value={r}>
                                          {r}
                                        </option>
                                      ))}
                                    </select>
                                  </>
                                )}
                                <button
                                  type="button"
                                  className={isRemoved ? 'secondary btn-sm' : 'btn-soft-danger btn-sm'}
                                  onClick={() =>
                                    setRemoved((prev) =>
                                      prev.includes(i.key) ? prev.filter((k) => k !== i.key) : [...prev, i.key],
                                    )
                                  }
                                >
                                  {isRemoved ? (
                                    <>
                                      <RotateCcw size={13} /> Restaurar
                                    </>
                                  ) : (
                                    <>
                                      <Trash2 size={13} /> Excluir item
                                    </>
                                  )}
                                </button>
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    )}

                    {(mode === 'new' || context.materials) && (
                      <SheetMaterials
                        documentOnly={false}
                        materials={context.materials || []}
                        items={items}
                        setItems={setItems}
                        project={baseSnapshot?.unit}
                      />
                    )}

                    <details>
                      <summary>Identificação da empresa e do colaborador</summary>
                      <div className="fepi-grid">
                        {identityFields.map(([key, label]) => (
                          <Field
                            key={key}
                            label={label}
                            readOnly={key === 'unit' && (items.length > 0 || doc?.snapshot.items.some((i) => i.reason))}
                            maxLength={254}
                            value={settings.identity[key]}
                            onChange={(e) => field('identity', { ...settings.identity, [key]: e.target.value })}
                          />
                        ))}
                      </div>
                    </details>

                    <details>
                      <summary>Logo e textos da ficha</summary>
                      <Field
                        label="Logo da empresa (1:1)"
                        type="file"
                        accept="image/png,image/jpeg,image/webp"
                        onChange={(e) => {
                          const file = e.target.files?.[0]
                          e.target.value = ''
                          if (file) run(async () => field('logo', await squareLogo(file)))
                        }}
                      />
                      {settings.logo && (
                        <div className="fepi-logo-preview">
                          <img alt="Logo selecionada" src={settings.logo} />
                          <button type="button" className="secondary" onClick={() => field('logo', '')}>
                            Remover logo
                          </button>
                        </div>
                      )}
                      <label>
                        Fundamentação legal
                        <textarea
                          aria-label="Fundamentação legal"
                          rows={6}
                          value={settings.legal}
                          maxLength={20000}
                          onChange={(e) => field('legal', e.target.value)}
                        />
                      </label>
                      <label>
                        Termo de responsabilidade
                        <textarea
                          aria-label="Termo de responsabilidade"
                          rows={5}
                          value={settings.term}
                          maxLength={20000}
                          onChange={(e) => field('term', e.target.value)}
                        />
                      </label>
                      {profile.is_master && (baseSnapshot?.company || baseSnapshot?.cnpj) && (
                        <label className="epi-check">
                          <input
                            type="checkbox"
                            checked={template}
                            onChange={(e) => setTemplate(e.target.checked)}
                          />{' '}
                          Usar esta logo e estes textos nas próximas fichas desta empresa
                        </label>
                      )}
                    </details>

                    <Field
                      label="Local de assinatura"
                      value={settings.place}
                      maxLength={200}
                      onChange={(e) => field('place', e.target.value)}
                    />

                    <div className="button-group">
                      <button className="primary" disabled={busy || !settings.term.trim() || !settings.legal.trim()}>
                        {mode === 'new' ? 'Salvar e emitir ficha' : 'Salvar alterações e sincronizar estoque'}
                      </button>
                      {mode === 'edit' && (
                        <button className="secondary" type="button" onClick={() => view(doc)}>
                          Cancelar edição
                        </button>
                      )}
                    </div>
                  </fieldset>
                </form>
              </Panel>
            )}
          </div>

          {/* Coluna Direita: Pré-visualização da Ficha de EPI na Lateral */}
          <div className="fepi-preview-column">
            <div className="fepi-preview-sticky">
              <div className="fepi-preview-header">
                <div className="fepi-preview-title">
                  <FileText size={16} />
                  <span>Pré-visualização da Ficha de EPI</span>
                </div>
                <button
                  type="button"
                  className="secondary fepi-print-btn"
                  disabled={busy}
                  onClick={() => window.print()}
                  title="Imprimir ou exportar PDF da ficha"
                >
                  <Printer size={15} /> Imprimir / Salvar PDF
                </button>
              </div>
              <div className="fepi-document-container">
                <SheetDocument
                  snapshot={effectiveSnapshot}
                  settings={effectiveSettings}
                  number={doc?.number}
                  issuedAt={doc?.issued_at}
                />
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export function Sheet({ db, data, profile, onIssued, sheetRequest, clearRequest }) {
  const [id, setId] = useState('')
  const [people, setPeople] = useState([]),
    [error, setError] = useState(''),
    [attempt, retry] = useState(0)
  const [archive, setArchive] = useState([]),
    [archiveId, setArchiveId] = useState('')
  const [search, setSearch] = useState('')
  const [showSuggestions, setShowSuggestions] = useState(false)
  const inputRef = useRef(null)
  const listRef = useRef(null)

  useEffect(() => {
    if (sheetRequest) {
      setId(sheetRequest.employee_id)
      setArchiveId('')
      setSearch(sheetRequest.employee || '')
    }
  }, [sheetRequest?.id])

  const archivedSheet = archive.find((s) => s.id === archiveId)

  useEffect(() => {
    let current = true
    const refresh = () => retry((n) => n + 1)
    window.addEventListener('focus', refresh)
    Promise.all([
      rpc(db, 'sheet', { action: 'employees', p: {} }),
      profile.is_master ? rpc(db, 'sheet', { action: 'archived', p: {} }) : [],
    ])
      .then(([list, docs]) => {
        if (current) {
          setPeople(list)
          setArchive(docs)
          setError('')
          setId((selected) => (list.some((e) => e.id === selected) ? selected : ''))
          setArchiveId((selected) => (docs.some((d) => d.id === selected) ? selected : ''))
        }
      })
      .catch((e) => {
        if (current) setError(e.message)
      })
    return () => {
      current = false
      window.removeEventListener('focus', refresh)
    }
  }, [db, attempt, profile.is_master])

  const norm = (v) =>
    String(v || '')
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      .toLocaleLowerCase('pt-BR')
      .trim()
  const term = norm(search)
  const filtered = term ? people.filter((e) => norm(e.name).includes(term)) : people
  const selectedPerson = people.find((e) => e.id === id)

  function selectPerson(person) {
    clearRequest?.()
    setId(person.id)
    setSearch(person.name)
    setShowSuggestions(false)
    setArchiveId('')
  }

  function handleClear() {
    clearRequest?.()
    setId('')
    setSearch('')
    setShowSuggestions(false)
    setArchiveId('')
  }

  useEffect(() => {
    function handleClick(e) {
      if (
        inputRef.current &&
        !inputRef.current.contains(e.target) &&
        listRef.current &&
        !listRef.current.contains(e.target)
      ) {
        setShowSuggestions(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  return (
    <div className="fepi-shell">
      <div className="fepi-top-selector card">
        {sheetRequest && (
          <div className="epi-autocomplete-request">
            <p>
              Ficha da solicitação <strong>{sheetRequest.tracking_code}</strong> · {sheetRequest.employee}
            </p>
            <button className="secondary" onClick={handleClear}>
              Nova ficha manual
            </button>
          </div>
        )}
        <div className="fepi-search-row">
          <div className="epi-autocomplete" ref={inputRef}>
            <div className="epi-autocomplete-input">
              <Search size={16} className="epi-autocomplete-icon" />
              <input
                type="text"
                placeholder="Buscar colaborador para emitir, editar ou excluir ficha de EPI…"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value)
                  setShowSuggestions(true)
                  if (!e.target.value.trim()) {
                    setId('')
                    setArchiveId('')
                  }
                }}
                onFocus={() => setShowSuggestions(true)}
                autoComplete="off"
              />
              {search && (
                <button type="button" className="epi-clear-search-btn" onClick={handleClear} aria-label="Limpar busca">
                  <X size={15} />
                </button>
              )}
            </div>

            {showSuggestions && search.trim() && filtered.length > 0 && (
              <ul className="epi-autocomplete-list" ref={listRef} role="listbox">
                {filtered.slice(0, 10).map((person) => (
                  <li
                    key={person.id}
                    role="option"
                    aria-selected={person.id === id}
                    className={person.id === id ? 'selected' : ''}
                    onClick={() => selectPerson(person)}
                  >
                    <User size={15} />
                    <span>{person.name}</span>
                    {person.project && <small className="fepi-person-badge">{person.project}</small>}
                  </li>
                ))}
                {filtered.length > 10 && (
                  <li className="epi-autocomplete-more">+{filtered.length - 10} resultados — continue digitando</li>
                )}
              </ul>
            )}

            {showSuggestions && search.trim() && !filtered.length && (
              <div className="epi-autocomplete-empty">Nenhum colaborador encontrado com esse nome.</div>
            )}
          </div>

          {selectedPerson && (
            <div className="fepi-selected-badge">
              <UserCheck size={16} />
              <span>
                <strong>{selectedPerson.name}</strong> {selectedPerson.project ? `(${selectedPerson.project})` : ''}
              </span>
              <button type="button" className="fepi-badge-remove" onClick={handleClear} title="Trocar colaborador">
                <X size={14} />
              </button>
            </div>
          )}
        </div>

        {archive.length > 0 && (
          <div style={{ marginTop: '0.75rem' }}>
            <Select
              label="Fichas emitidas de colaboradores desativados"
              value={archiveId}
              options={archive.map((s) => [s.id, 'Nº ' + s.number + ' · ' + stamp(s.issued_at)])}
              onChange={(e) => {
                clearRequest?.()
                setArchiveId(e.target.value)
                setId('')
              }}
            />
          </div>
        )}
      </div>

      {error && (
        <p className="notice error" role="alert">
          {error} <button onClick={() => retry(attempt + 1)}>Tentar novamente</button>
        </p>
      )}

      {!id && !archivedSheet && (
        <div className="fepi-empty-guide card">
          <FileText size={48} className="fepi-empty-icon" />
          <h3>Nenhum colaborador selecionado</h3>
          <p>
            Digite as primeiras letras do nome do colaborador no campo de busca acima e selecione para emitir uma nova
            ficha, editar itens ou excluir fichas emitidas.
          </p>
        </div>
      )}

      {id && (
        <EmployeeSheets
          key={id + (sheetRequest?.id || '')}
          request={sheetRequest}
          db={db}
          id={id}
          profile={profile}
          onIssued={onIssued}
          delivered={data?.requests?.filter((q) => q.employee_id === id && q.status === 'Entregue') || []}
        />
      )}

      {archivedSheet && (
        <EmployeeSheets
          key={archiveId}
          db={db}
          id={archivedSheet.employee_id}
          profile={profile}
          archiveId={archiveId}
          delivered={[]}
          onArchiveDeleted={() => {
            setArchiveId('')
            retry((n) => n + 1)
          }}
        />
      )}
    </div>
  )
}
