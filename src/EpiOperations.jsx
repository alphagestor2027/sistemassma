import { usePages } from './Pagination'
import { CostBreakdown, DateRange, within } from './EpiReports'
import React, { useState } from 'react'
import {
  RefreshCw,
  Trash2,
  Search,
  FileText,
  Pencil,
  CircleCheck,
  Clock,
  Barcode,
  Coins,
  Footprints,
  Headphones,
  Shirt,
  Glasses,
  Hand,
  HardHat,
  Shield,
  Package,
  Boxes,
  Send,
  Inbox,
  TriangleAlert,
  RotateCcw,
} from 'lucide-react'
import { Panel, ActionForm, Field, Select, Table } from './EpiShared'
import { money, variant, expenseGroups, stamp, nextStatus, REQUEST_STAGES, normalizeRequestStage, available } from './epiData'
import { today, dateLabel } from './data'
import './stock-indicators.css'

export { REQUEST_STAGES, normalizeRequestStage }

const LEGACY_STAGE_FALLBACK = {
  'Solicitações recebidas': 'Pedido recebido',
  'Para Aprovação do Gestor': 'Aguardando aprovação do projeto',
  'Em Separação': 'Pedido separado',
  Enviada: 'Enviado pelos Correios',
}

export function StockImpactNotice({ context = 'editada, alterada ou removida' }) {
  return (
    <div className="epi-stock-warning-banner" role="note">
      <TriangleAlert size={18} aria-hidden="true" />
      <div>
        <strong>Aviso: atualização automática no estoque</strong>
        <p>
          Toda ficha ou solicitação que for {context} tem a quantidade refletida imediatamente no saldo físico do
          estoque e nos lançamentos financeiros vinculados.
        </p>
      </div>
    </div>
  )
}

function personInitials(name) {
  const parts = String(name || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  if (!parts.length) return 'EP'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

const avatarTones = ['rose', 'blue', 'emerald', 'amber', 'violet']
function avatarTone(name) {
  let hash = 0
  const s = String(name || '')
  for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) | 0
  return avatarTones[Math.abs(hash) % avatarTones.length]
}

function ItemIcon({ name }) {
  const n = String(name || '').toLowerCase()
  const props = { size: 16, 'aria-hidden': 'true', className: 'epi-item-icon' }
  if (/bota|botina|calcad|calçad|sapato|tenis|tênis/.test(n)) return <Footprints {...props} />
  if (/auditiv|abafador|plug|auricular/.test(n)) return <Headphones {...props} />
  if (/camisa|calca|calça|avental|jaleco|colete|blusa|jaqueta|uniforme|conjunto/.test(n)) return <Shirt {...props} />
  if (/oculos|óculos|viseira|lente/.test(n)) return <Glasses {...props} />
  if (/luva|manga/.test(n)) return <Hand {...props} />
  if (/capacete|jugular|capuz|balaclava/.test(n)) return <HardHat {...props} />
  if (/cinto|talabarte|trava|respirador|mascara|máscara|pff|filtro|perneira/.test(n)) return <Shield {...props} />
  return <Package {...props} />
}

function StageBadge({ stage }) {
  if (stage === 'Concluída') {
    return (
      <span className="badge badge-icon green">
        <CircleCheck size={13} aria-hidden="true" />
        <span>Concluída</span>
      </span>
    )
  }
  if (stage === 'Enviada') {
    return (
      <span className="badge badge-icon violet">
        <Send size={13} aria-hidden="true" />
        <span>Enviada</span>
      </span>
    )
  }
  if (stage === 'Em Separação') {
    return (
      <span className="badge badge-icon blue">
        <Boxes size={13} aria-hidden="true" />
        <span>Em Separação</span>
      </span>
    )
  }
  if (stage === 'Para Aprovação do Gestor') {
    return (
      <span className="badge badge-icon amber">
        <Clock size={13} aria-hidden="true" />
        <span>Para Aprovação do Gestor</span>
      </span>
    )
  }
  if (stage === 'Cancelado') {
    return (
      <span className="badge badge-icon gray">
        <span>Cancelado</span>
      </span>
    )
  }
  return (
    <span className="badge badge-icon red">
      <Inbox size={13} aria-hidden="true" />
      <span>Solicitações recebidas</span>
    </span>
  )
}

function RequestItemsEditor({ request, materials, onSave, onCancel }) {
  const [quantities, setQuantities] = useState(() =>
    Object.fromEntries(request.complete.map((i) => [i.material_id, String(i.qty)])),
  )
  const [removedIds, setRemovedIds] = useState([])
  const [addedItems, setAddedItems] = useState([])
  const [addMatId, setAddMatId] = useState('')
  const [addQty, setAddQty] = useState('1')
  const [addReason, setAddReason] = useState('Inicial')
  const [note, setNote] = useState(request.management_note || '')
  const [postal, setPostal] = useState(request.postal || '')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const keptCount = request.complete.filter((i) => !removedIds.includes(i.material_id)).length
  const unitMaterials = materials.filter((m) => m.region_id === request.region_id && available(m) > 0)

  function toggleRemoveItem(materialId) {
    setErr('')
    if (removedIds.includes(materialId)) {
      setRemovedIds((prev) => prev.filter((id) => id !== materialId))
    } else {
      if (keptCount + addedItems.length <= 1) {
        setErr(
          'A ficha precisa manter ao menos 1 item. Para retirar todos os itens e estorná-los ao estoque, clique no botão "Remover" da solicitação.',
        )
        return
      }
      setRemovedIds((prev) => [...prev, materialId])
    }
  }

  function handleAddMaterial() {
    setErr('')
    if (!addMatId) {
      setErr('Selecione um material disponível para adicionar.')
      return
    }
    const qVal = Number(addQty)
    if (!Number.isInteger(qVal) || qVal < 1) {
      setErr('Informe uma quantidade inteira válida (mínimo 1) para incluir o item.')
      return
    }
    const mat = unitMaterials.find((m) => m.id === addMatId)
    if (!mat) return
    if (qVal > available(mat)) {
      setErr(`Saldo insuficiente para ${variant(mat)}. Disponível: ${available(mat)}.`)
      return
    }
    setAddedItems((prev) => {
      const existing = prev.find((x) => x.id === addMatId)
      if (existing) {
        return prev.map((x) => (x.id === addMatId ? { ...x, qty: x.qty + qVal } : x))
      }
      return [...prev, { id: mat.id, name: variant(mat), qty: qVal, reason: addReason }]
    })
    setAddMatId('')
    setAddQty('1')
  }

  async function handleSubmit(e) {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setErr('')
    try {
      const parsedQuantities = {}
      for (const item of request.complete) {
        if (removedIds.includes(item.material_id)) continue
        const n = Number(quantities[item.material_id])
        if (!Number.isInteger(n) || n < 1) {
          throw new Error(`Informe uma quantidade inteira válida (mínimo 1) para ${variant(item)}.`)
        }
        parsedQuantities[item.material_id] = n
      }
      await onSave({
        request_id: request.id,
        status: request.status,
        previous_note: request.management_note || '',
        previous_postal: request.postal || '',
        note,
        postal,
        previous_qty: Object.fromEntries(request.complete.map((i) => [i.material_id, i.qty])),
        quantities: parsedQuantities,
        removed_materials: removedIds,
        added_materials: addedItems.map(({ id, qty, reason }) => ({ id, qty, reason })),
      })
      onCancel()
    } catch (error) {
      setErr(error.message || 'Não foi possível salvar as alterações da ficha.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="epi-request-edit-box" onSubmit={handleSubmit}>
      <StockImpactNotice context="editada ou tiver itens alterados, incluídos ou excluídos" />

      <div className="epi-edit-items-list">
        <h4>Itens da ficha / solicitação</h4>
        {request.complete.map((item) => {
          const isRemoved = removedIds.includes(item.material_id)
          const stockMat = materials.find((m) => m.id === item.material_id)
          const extraAvail = stockMat ? available(stockMat) : 0
          const currentVal = Number(quantities[item.material_id] || item.qty)
          const diff = isRemoved ? -item.qty : currentVal - item.qty

          return (
            <div key={item.material_id} className={'epi-edit-item-row' + (isRemoved ? ' is-removed' : '')}>
              <div className="epi-edit-item-info">
                <strong>{variant(item)}</strong>
                <small>
                  Quantidade original: {item.qty}
                  {stockMat ? ` · Disponível no estoque: ${extraAvail}` : ''}
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
                  <label className="epi-inline-qty">
                    <span>Qtd.</span>
                    <input
                      type="number"
                      min={1}
                      step={1}
                      required
                      disabled={busy}
                      value={quantities[item.material_id] ?? item.qty}
                      onChange={(e) =>
                        setQuantities((prev) => ({ ...prev, [item.material_id]: e.target.value }))
                      }
                    />
                  </label>
                )}
                <button
                  type="button"
                  disabled={busy}
                  className={isRemoved ? 'secondary btn-sm' : 'btn-soft-danger btn-sm'}
                  onClick={() => toggleRemoveItem(item.material_id)}
                >
                  {isRemoved ? (
                    <>
                      <RotateCcw size={13} aria-hidden="true" /> Restaurar item
                    </>
                  ) : (
                    <>
                      <Trash2 size={13} aria-hidden="true" /> Excluir item
                    </>
                  )}
                </button>
              </div>
            </div>
          )
        })}

        {addedItems.map((added) => (
          <div key={'add-' + added.id} className="epi-edit-item-row">
            <div className="epi-edit-item-info">
              <strong>+ {added.name}</strong>
              <small>
                Novo item · Qtd.: {added.qty} · {added.reason}
                <span className="epi-stock-delta consume"> (-{added.qty} sai do estoque)</span>
              </small>
            </div>
            <button
              type="button"
              disabled={busy}
              className="btn-soft-danger btn-sm"
              onClick={() => setAddedItems((prev) => prev.filter((x) => x.id !== added.id))}
            >
              <Trash2 size={13} aria-hidden="true" /> Retirar inclusão
            </button>
          </div>
        ))}
      </div>

      {unitMaterials.length > 0 && (
        <div className="epi-add-item-box">
          <strong>Incluir novo item nesta ficha</strong>
          <div className="epi-filters">
            <Select
              label="Material disponível"
              placeholder="Selecione um material"
              value={addMatId}
              onChange={(e) => setAddMatId(e.target.value)}
              options={unitMaterials.map((m) => [m.id, `${variant(m)} (${available(m)} disp.)`])}
            />
            <Field
              label="Qtd."
              type="number"
              min={1}
              step={1}
              value={addQty}
              onChange={(e) => setAddQty(e.target.value)}
            />
            <Select
              label="Motivo"
              value={addReason}
              onChange={(e) => setAddReason(e.target.value)}
              options={['Inicial', 'Substituição por perda ou roubo', 'Substituição por período de troca/desgaste']}
            />
            <button type="button" className="secondary btn-sm" disabled={busy} onClick={handleAddMaterial}>
              Incluir item
            </button>
          </div>
        </div>
      )}

      <div className="epi-filters" style={{ marginTop: 10 }}>
        <Field
          label="Observação da solicitação"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={500}
        />
        <Field
          label="Rastreio dos Correios"
          value={postal}
          onChange={(e) => setPostal(e.target.value)}
          maxLength={64}
        />
      </div>

      {err && (
        <p role="alert" className="form-error">
          {err}
        </p>
      )}

      <div className="button-group">
        <button type="button" className="secondary" disabled={busy} onClick={onCancel}>
          Cancelar edição
        </button>
        <button type="submit" className="primary" disabled={busy}>
          {busy ? 'Salvando e atualizando estoque…' : 'Salvar alterações da ficha'}
        </button>
      </div>
    </form>
  )
}

export function Requests({ data, profile, save, refresh, initialFocus, onSheet, externalStatus = '', onExternalStatus }) {
  const [localStatus, setLocalStatus] = useState('')
  const status = externalStatus || localStatus
  const setStatus = (val) => {
    setLocalStatus(val)
    onExternalStatus?.(val)
  }
  const [search, setSearch] = useState('')
  const [focused, setFocused] = useState(initialFocus)
  const [action, setAction] = useState('')
  const [signingId, setSigningId] = useState(null)
  const [signError, setSignError] = useState('')

  async function toggleSigned(q) {
    if (signingId) return
    setSigningId(q.id)
    setSignError('')
    try {
      await save('toggle_signed', { request_id: q.id, signed: !q.sheet_signed })
    } catch (e) {
      setSignError(e.message || 'Não foi possível atualizar a assinatura da ficha.')
    } finally {
      setSigningId(null)
    }
  }

  async function saveStageProgress(q, p) {
    try {
      return await save('progress', {
        ...p,
        request_id: q.id,
        previous_stage: q.stage,
        previous_postal: q.postal,
      })
    } catch (err) {
      if (/Etapa inválida|Status inválido/i.test(err.message || '')) {
        if (p.stage === 'Concluída') {
          if (p.postal && p.postal !== q.postal) {
            await save('progress', {
              stage: 'Enviado pelos Correios',
              postal: p.postal,
              request_id: q.id,
              previous_stage: q.stage,
              previous_postal: q.postal,
            })
          }
          return await save('deliver', { request_id: q.id, destination: 'Projeto' })
        }
        const mapped = LEGACY_STAGE_FALLBACK[p.stage] || 'Pedido recebido'
        return await save('progress', {
          ...p,
          stage: mapped,
          request_id: q.id,
          previous_stage: q.stage,
          previous_postal: q.postal,
        })
      }
      throw err
    }
  }

  const activeRequests = data.requests.filter((q) => !q.list_removed)
  const term = search.trim().toLocaleLowerCase('pt-BR')
  const list = activeRequests.filter((q) => {
    const normalized = normalizeRequestStage(q)
    const matchesStatus = !status || normalized === status || q.status === status
    const matchesFocus = !focused || q.id === focused
    const matchesSearch =
      !term ||
      [q.employee, q.tracking_code, q.project, ...q.items.map(variant)].some((value) =>
        String(value || '').toLocaleLowerCase('pt-BR').includes(term),
      )
    return matchesStatus && matchesFocus && matchesSearch
  })

  const pages = usePages(
    list.flatMap((q) => q.items.map((item) => ({ q, item }))),
    status + '|' + search,
  )
  const visible = new Map()
  for (const { q, item } of pages.items) {
    if (!visible.has(q.id)) visible.set(q.id, { ...q, items: [], complete: q.items })
    visible.get(q.id).items.push(item)
  }

  return (
    <Panel
      title="Solicitações dos colaboradores"
      action={
        <div className="button-group">
          <button className="primary btn-compact" onClick={refresh}>
            <RefreshCw size={15} aria-hidden="true" /> Atualizar solicitações
          </button>
          {activeRequests.length > 0 && (
            <button className="ghost-danger-btn" onClick={() => setAction(action === 'clear' ? '' : 'clear')}>
              <Trash2 size={15} aria-hidden="true" /> Limpar solicitações
            </button>
          )}
        </div>
      }
    >
      {action === 'clear' && (
        <ActionForm submit="Confirmar limpeza e estornar estoque" onSave={() => save('clear_requests', {})} onDone={() => setAction('')}>
          <StockImpactNotice context="removida ou limpa da listagem" />
          <p>
            Remover todas as solicitações e fichas listadas? Todas as unidades entregues ou reservadas retornarão
            imediatamente ao saldo do estoque e as despesas financeiras vinculadas serão estornadas.
          </p>
          <button type="button" className="secondary" onClick={() => setAction('')}>
            Voltar
          </button>
        </ActionForm>
      )}
      <div className="epi-filters epi-requests-filters">
        {focused && (
          <button className="secondary" onClick={() => setFocused(null)}>
            Ver todas as solicitações
          </button>
        )}
        <Field
          label="Buscar solicitação"
          type="search"
          className="epi-search-wide"
          icon={<Search size={15} aria-hidden="true" />}
          placeholder="Colaborador, projeto, material ou rastreio"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <Select
          label="Gestão de status"
          placeholder="Todos os status"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          options={[...REQUEST_STAGES, 'Cancelado']}
        />
      </div>
      {signError && (
        <p role="alert" className="form-error">
          {signError}
        </p>
      )}
      <div className="epi-request-list">
        {[...visible.values()].map((q) => {
          const reg = data.regions.find((r) => r.id === q.region_id)
          const tone = avatarTone(q.employee)
          const currentStage = normalizeRequestStage(q)
          return (
            <article className="epi-request" key={q.id}>
              <header>
                <div className="epi-request-person">
                  <span className={'epi-request-avatar tone-' + tone} aria-hidden="true">
                    {personInitials(q.employee)}
                  </span>
                  <div>
                    <strong>{q.employee}</strong>
                    <small>
                      {q.project} · {q.state} · {q.job} · {stamp(q.created_at)}
                    </small>
                  </div>
                </div>
                <div className="epi-request-status-stack">
                  <StageBadge stage={currentStage} />
                  {q.status === 'Entregue' && (
                    <button
                      type="button"
                      role="switch"
                      aria-checked={Boolean(q.sheet_signed)}
                      aria-label={'Marcar ficha de ' + q.employee + ' como assinada'}
                      disabled={signingId === q.id}
                      className={'epi-sign-switch' + (q.sheet_signed ? ' is-signed' : '')}
                      onClick={() => toggleSigned(q)}
                      title={q.sheet_signed ? 'Ficha assinada (clique para desmarcar)' : 'Marcar ficha como Assinada'}
                    >
                      <span className="epi-switch-track" aria-hidden="true">
                        <span className="epi-switch-thumb" />
                      </span>
                      <span className="epi-switch-label">Assinada</span>
                    </button>
                  )}
                </div>
              </header>
              <ul className="epi-request-items">
                {q.items.map((i, idx) => {
                  const extras = [i.size && 'Tam. ' + i.size, i.color].filter(Boolean).join(' · ')
                  return (
                    <li key={(i.material_id || idx) + '-' + idx}>
                      <ItemIcon name={i.name} />
                      <span>
                        <strong>
                          {i.qty} × {i.name}
                        </strong>
                        {extras && <span className="epi-item-meta">{' · ' + extras}</span>}
                      </span>
                    </li>
                  )
                })}
              </ul>
              {q.complete.length > q.items.length && (
                <details>
                  <summary>Ver solicitação completa ({q.complete.length} itens)</summary>
                  <p>{q.complete.map((i) => i.qty + ' × ' + variant(i)).join(', ')}</p>
                </details>
              )}
              {q.status === 'Solicitado' && (
                <p className="epi-request-stage">
                  Status atual: <strong>{currentStage}</strong>
                  {q.postal && ' · Correios: ' + q.postal}
                  {(q.technician || reg?.technician) && ' · Técnico responsável: ' + (q.technician || reg?.technician)}
                </p>
              )}
              {q.status === 'Solicitado' &&
                !q.employee_removed &&
                (profile.is_master || reg?.id === (profile.stock_unit || profile.user_id)) && (
                  <ActionForm
                    key={q.stage + '|' + q.postal}
                    submit="Salvar status"
                    onSave={(p) => saveStageProgress(q, p)}
                  >
                    <Select
                      label="Alterar status da solicitação"
                      name="stage"
                      options={REQUEST_STAGES}
                      defaultValue={currentStage}
                      required
                    />
                    <Field
                      label="Número de rastreamento dos Correios"
                      name="postal"
                      defaultValue={q.postal}
                      maxLength={64}
                    />
                  </ActionForm>
                )}
              {q.status === 'Solicitado' && (
                <div className="epi-request-actions">
                  <details>
                    <summary>Cancelar solicitação</summary>
                    <StockImpactNotice context="cancelada" />
                    <ActionForm submit="Confirmar cancelamento" onSave={() => save('cancel', { request_id: q.id })} />
                  </details>
                </div>
              )}
              {q.management_note && <p className="epi-request-note">{q.management_note}</p>}
              <div className="epi-request-footer">
                <div className="epi-request-meta">
                  <span className="epi-meta-chip">
                    <Barcode size={15} aria-hidden="true" />
                    <span>{q.tracking_code}</span>
                  </span>
                  {q.status !== 'Solicitado' && q.destination && (
                    <span className="epi-meta-chip">
                      <Coins size={14} aria-hidden="true" />
                      <span>Custo do {q.destination === 'Projeto' ? 'projeto' : q.destination}</span>
                    </span>
                  )}
                  {q.status !== 'Solicitado' && q.postal && <span className="epi-meta-chip">Correios: {q.postal}</span>}
                </div>
                <div className="epi-request-btns">
                  {onSheet && !q.employee_removed && q.status !== 'Cancelado' && (
                    <button className="btn-outline-red" onClick={() => onSheet(q)}>
                      <FileText size={15} aria-hidden="true" /> Abrir ficha de EPI
                    </button>
                  )}
                  {q.status !== 'Cancelado' && (
                    <button
                      className="secondary btn-sm"
                      onClick={() => setAction(action === 'edit' + q.id ? '' : 'edit' + q.id)}
                    >
                      <Pencil size={14} aria-hidden="true" /> Editar ficha
                    </button>
                  )}
                  <button
                    className="btn-soft-danger btn-sm"
                    onClick={() => setAction(action === 'remove' + q.id ? '' : 'remove' + q.id)}
                  >
                    <Trash2 size={14} aria-hidden="true" /> Remover
                  </button>
                </div>
              </div>

              {action === 'edit' + q.id && (
                <RequestItemsEditor
                  request={q}
                  materials={data.materials || []}
                  onSave={(payload) => save('edit_request', payload)}
                  onCancel={() => setAction('')}
                />
              )}

              {action === 'remove' + q.id && (
                <div className="epi-request-remove-box">
                  <StockImpactNotice context="removida ou excluída" />
                  <ActionForm
                    submit="Confirmar exclusão e estornar estoque"
                    onDone={() => setAction('')}
                    onSave={() => save('remove_request', { request_id: q.id })}
                  >
                    <p>
                      {q.status === 'Entregue'
                        ? 'Excluir esta ficha de entrega? Todos os materiais entregues retornarão ao saldo do estoque e o lançamento financeiro de saída será estornado.'
                        : 'Remover esta solicitação? As unidades reservadas voltarão imediatamente para o saldo disponível do estoque.'}
                    </p>
                    <button type="button" className="secondary" onClick={() => setAction('')}>
                      Voltar
                    </button>
                  </ActionForm>
                </div>
              )}
            </article>
          )
        })}
      </div>
      {pages.controls}
      {!list.length && <p className="epi-empty">Nenhuma solicitação para os filtros selecionados.</p>}
    </Panel>
  )
}

export function Finance({ data, children }) {
  const [range, setRange] = useState({ start: '', end: '' })
  const movements = data.movements.filter((m) => within(m.created_at, range))
  const groups = expenseGroups(data.requests.filter((request) => within(request.closed_at, range)))
  const sum = (list, fn) => list.reduce((s, x) => s + fn(x), 0)
  const movementCents = (kinds) =>
    sum(
      movements.filter((m) => kinds.includes(m.kind)),
      (m) => m.qty * Math.round(Number(m.price) * 100),
    )
  const netEntryValue =
    Math.max(0, movementCents(['Entrada', 'Ajuste de entrada']) - movementCents(['Ajuste de saída'])) / 100
  const exitValue = movementCents(['Saída']) / 100
  const groupValue = (d) =>
    sum(
      groups.filter((g) => g.destination === d),
      (g) => g.cents,
    ) / 100

  return (
    <>
      <Panel
        title="Movimentação financeira"
        className="epi-finance-hero"
        action={<DateRange value={range} onChange={setRange} compact />}
      >
        <div className="epi-metrics">
          {[
            ['Entradas de material', netEntryValue, 'neutral'],
            ['Saídas por entrega', exitValue, 'neutral'],
            ['Despesas dos projetos', groupValue('Projeto'), 'rose'],
            [
              'Saldo financeiro em estoque · SSMA',
              sum(data.materials, (m) => m.qty * Math.round(m.price * 100)) / 100,
              'green',
            ],
            ['Entregas históricas ao SSMA', groupValue('SSMA'), 'neutral'],
          ].map(([label, v, tone]) => (
            <div key={label} className={'epi-metric-card tone-' + tone}>
              <small>{label}</small>
              <strong>{money(v)}</strong>
            </div>
          ))}
        </div>
      </Panel>
      <div className="epi-finance-middle">
        {children}
        <CostBreakdown requests={data.requests} range={range} />
      </div>
      <Panel title="Extrato de entradas e saídas">
        <Table
          headers={['Data', 'Movimento', 'Material', 'Quantidade', 'Valor unitário', 'Valor total']}
          rows={movements.map((m) => [
            stamp(m.created_at),
            <span className={'badge ' + (m.kind === 'Entrada' ? 'green' : 'gray')}>{m.kind}</span>,
            <strong className="material-strong">
              {variant(m.material_label || data.materials.find((i) => i.id === m.material_id) || { name: 'Material excluído' })}
            </strong>,
            m.qty,
            money(m.price),
            <strong className="money-strong">{money(m.qty * m.price)}</strong>,
          ])}
        />
      </Panel>
    </>
  )
}

export function Tests({ data, save }) {
  const [delivery, setDelivery] = useState(''),
    [filter, setFilter] = useState('')
  const delivered = data.requests.filter((q) => q.status === 'Entregue')
  const selected = delivered.find((q) => q.id === delivery)
  const list = data.assets.filter((a) => !filter || a.status === filter)
  return (
    <>
      <Panel title="Vincular equipamento a uma entrega">
        <ActionForm submit="Registrar equipamento" onSave={(p) => save('asset', p)} onDone={() => setDelivery('')}>
          <Select
            label="Entrega confirmada"
            name="request_id"
            value={delivery}
            onChange={(e) => setDelivery(e.target.value)}
            options={delivered.map((q) => [
              q.id,
              q.employee + ' · ' + q.project + ' · ' + stamp(q.closed_at) + ' · ' + q.id.slice(0, 8),
            ])}
            required
          />
          <Select
            label="Equipamento entregue"
            name="material_id"
            options={(selected?.items || [])
              .filter(
                (i) =>
                  data.assets.filter((a) => a.request_id === delivery && a.material_id === i.material_id).length < i.qty,
              )
              .map((i) => [i.material_id, variant(i)])}
            required
          />
          <Field label="Número de série / patrimônio" name="serial" required />
          <Field label="Intervalo de reteste (dias)" name="days" type="number" min={1} required />
          <Field label="Próximo ensaio" name="due" type="date" required />
        </ActionForm>
      </Panel>
      <Panel
        title="Logística reversa e ensaios"
        action={
          <Select
            label="Status do equipamento"
            value={filter}
            options={Object.keys(nextStatus)}
            placeholder="Todos"
            onChange={(e) => setFilter(e.target.value)}
          />
        }
      >
        {list.map((a) => {
          const q = delivered.find((q) => q.id === a.request_id)
          const item = q.items.find((i) => i.material_id === a.material_id)
          return (
            <article className="epi-request" key={a.id}>
              <header>
                <div>
                  <strong>
                    {variant(item)} · Série {a.serial}
                  </strong>
                  <small>
                    {q.employee} · {q.project} · {q.state}
                  </small>
                </div>
                <span className={'badge ' + (a.status === 'Reprovado' ? 'red' : 'gray')}>{a.status}</span>
              </header>
              <p className={a.due <= today() ? 'red-text' : ''}>
                Próximo ensaio em {dateLabel(a.due)} · a cada {a.period_days} dias
              </p>
              {nextStatus[a.status]?.length > 0 && <TestForm key={a.status} asset={a} save={save} />}
              <details>
                <summary>Histórico do equipamento</summary>
                <Table
                  headers={['Data', 'Situação', 'Laboratório', 'Laudo / observação']}
                  rows={a.history.map((t) => [stamp(t.created_at), t.status, t.lab, t.report || '—'])}
                  empty="Equipamento em uso. Aguardando o primeiro envio."
                />
              </details>
            </article>
          )
        })}
        {!list.length && <p className="epi-empty">Nenhum equipamento nesta situação.</p>}
      </Panel>
    </>
  )
}

function TestForm({ asset, save }) {
  const destinations = nextStatus[asset.status]
  return (
    <ActionForm submit="Registrar movimentação" onSave={(p) => save('test', { ...p, asset_id: asset.id })}>
      <Select
        label="Próxima situação"
        name="status"
        defaultValue={destinations.length === 1 ? destinations[0] : ''}
        options={destinations.map((s) => [s, s === 'Em retorno' ? 'Aprovado · iniciar retorno' : s])}
        required
      />
      {asset.status === 'Em uso' && <Field label="Laboratório de destino" name="lab" required />}
      <Field
        label={asset.status === 'No laboratório' ? 'Laudo / resultado do ensaio' : 'Observação'}
        name="report"
        required={asset.status === 'No laboratório'}
      />
    </ActionForm>
  )
}
