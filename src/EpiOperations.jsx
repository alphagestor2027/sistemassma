import {usePages} from './Pagination'
import {CostBreakdown, DateRange, within} from './EpiReports'
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
} from 'lucide-react'
import { Panel, ActionForm, Field, Select, Table } from './EpiShared'
import { money, variant, expenseGroups, stamp, nextStatus } from './epiData'
import { today, dateLabel } from './data'

const stages = [
  'Pedido recebido',
  'Pedido separado',
  'Aguardando aprovação do projeto',
  'Pronto para retirada na base',
  'Enviado pelos Correios',
]

function personInitials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean)
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

export function Requests({ data, profile, save, refresh, initialFocus, onSheet }) {
  const [status, setStatus] = useState('')
  const [search, setSearch] = useState('')
  const [focused,setFocused]=useState(initialFocus)
  const [action,setAction]=useState('')
  const activeRequests=data.requests.filter(q=>!q.list_removed)
  const term = search.trim().toLocaleLowerCase('pt-BR')
  const list = activeRequests.filter(q => (!status || q.status === status)&&(!focused||q.id===focused)&&(!term || [q.employee,q.tracking_code,...q.items.map(variant)].some(value=>String(value||'').toLocaleLowerCase('pt-BR').includes(term))))
  const pages=usePages(list.flatMap(q=>q.items.map(item=>({q,item}))),status+'|'+search)
  const visible=new Map()
  for(const {q,item} of pages.items){
    if(!visible.has(q.id)) visible.set(q.id,{...q,items:[],complete:q.items})
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
          {activeRequests.length>0&&(
            <button className="ghost-danger-btn" onClick={()=>setAction(action==='clear'?'':'clear')}>
              <Trash2 size={15} aria-hidden="true" /> Limpar solicitações
            </button>
          )}
        </div>
      }
    >
      {action==='clear'&&<ActionForm submit="Confirmar limpeza" onSave={()=>save('clear_requests',{})} onDone={()=>setAction('')}>
        <p>Remover todas as solicitações do seu acesso, em todos os períodos e situações? As reservas pendentes serão liberadas. As entregas continuarão no financeiro e nas fichas.</p>
        <button type="button" className="secondary" onClick={()=>setAction('')}>Voltar</button></ActionForm>}
      <div className="epi-filters epi-requests-filters">
        {focused&&<button className="secondary" onClick={()=>setFocused(null)}>Ver todas as solicitações</button>}
        <Field
          label="Buscar solicitação"
          type="search"
          className="epi-search-wide"
          icon={<Search size={15} aria-hidden="true" />}
          placeholder="Colaborador, material ou rastreio"
          value={search}
          onChange={e=>setSearch(e.target.value)}
        />
        <Select
          label="Situação"
          placeholder="Todas"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          options={['Solicitado', 'Entregue', 'Cancelado']}
        />
      </div>
      <div className="epi-request-list">
        {[...visible.values()].map((q) => {
          const reg = data.regions.find((r) => r.id === q.region_id)
          const tone = avatarTone(q.employee)
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
                <span
                  className={
                    'badge badge-icon ' + (q.status === 'Entregue' ? 'green' : q.status === 'Solicitado' ? 'red' : 'gray')
                  }
                >
                  {q.status === 'Entregue' ? <CircleCheck size={13} aria-hidden="true" /> : q.status === 'Solicitado' ? <Clock size={13} aria-hidden="true" /> : null}
                  <span>{q.status}</span>
                </span>
              </header>
              <ul className="epi-request-items">
                {q.items.map((i, idx) => {
                  const extras = [i.size && 'Tam. ' + i.size, i.color].filter(Boolean).join(' · ')
                  return (
                    <li key={(i.material_id || idx) + '-' + idx}>
                      <ItemIcon name={i.name} />
                      <span>
                        <strong>{i.qty} × {i.name}</strong>
                        {extras && <span className="epi-item-meta">{' · ' + extras}</span>}
                      </span>
                    </li>
                  )
                })}
              </ul>
              {q.complete.length>q.items.length&&<details><summary>Ver solicitação completa ({q.complete.length} itens)</summary>
                <p>{q.complete.map(i=>i.qty+' × '+variant(i)).join(', ')}</p></details>}
              {q.status === 'Solicitado' && (
                <p className="epi-request-stage">
                  Andamento: <strong>{q.stage}</strong>
                  {q.postal && ' · Correios: ' + q.postal}
                  {(q.technician || reg?.technician) && ' · Técnico responsável: ' + (q.technician || reg?.technician)}
                </p>
              )}
              {q.status === 'Solicitado' && !q.employee_removed && (profile.is_master || reg?.id === (profile.stock_unit || profile.user_id)) && (
                <ActionForm
                  key={q.stage + '|' + q.postal}
                  submit="Salvar andamento"
                  onSave={(p) =>
                    save('progress', {
                      ...p,
                      request_id: q.id,
                      previous_stage: q.stage,
                      previous_postal: q.postal,
                    })
                  }
                >
                  <Select
                    label="Etapa do pedido"
                    name="stage"
                    options={stages}
                    defaultValue={q.stage}
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
                    <p>A reserva dos materiais será liberada.</p>
                    <ActionForm
                      submit="Confirmar cancelamento"
                      onSave={() => save('cancel', { request_id: q.id })}
                    />
                  </details>
                </div>
              )}
              {q.management_note&&<p className="epi-request-note">{q.management_note}</p>}
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
                  {q.status !== 'Solicitado' && q.postal && (
                    <span className="epi-meta-chip">Correios: {q.postal}</span>
                  )}
                </div>
                <div className="epi-request-btns">
                  {onSheet && !q.employee_removed && q.status!=='Cancelado' && (
                    <button className="btn-outline-red" onClick={()=>onSheet(q)}>
                      <FileText size={15} aria-hidden="true" /> Abrir ficha de EPI
                    </button>
                  )}
                  <button className="secondary btn-sm" onClick={()=>setAction(action==='edit'+q.id?'':'edit'+q.id)}>
                    <Pencil size={14} aria-hidden="true" /> Editar
                  </button>
                  <button className="btn-soft-danger btn-sm" onClick={()=>setAction(action==='remove'+q.id?'':'remove'+q.id)}>
                    <Trash2 size={14} aria-hidden="true" /> Remover
                  </button>
                </div>
              </div>
              {action==='edit'+q.id&&<ActionForm submit="Salvar edição" onDone={()=>setAction('')} onSave={p=>save('edit_request',{
                request_id:q.id,status:q.status,previous_note:q.management_note||'',previous_postal:q.postal,note:p.note,postal:p.postal,
                previous_qty:Object.fromEntries(q.complete.map(i=>[i.material_id,i.qty])),quantities:p})}>
                <Field label="Observação da solicitação" name="note" defaultValue={q.management_note} maxLength={500}/>
                <Field label="Rastreio dos Correios" name="postal" defaultValue={q.postal} maxLength={64}/>
                {q.status==='Solicitado'&&q.complete.map(i=><Field key={i.material_id} label={'Quantidade · '+variant(i)} name={i.material_id} type="number" min={1} required defaultValue={i.qty}/>)}
                <button type="button" className="secondary" onClick={()=>setAction('')}>Cancelar edição</button></ActionForm>}
              {action==='remove'+q.id&&<ActionForm submit="Confirmar remoção" onDone={()=>setAction('')} onSave={()=>save('remove_request',{request_id:q.id})}>
                <p>Remover esta solicitação da lista? Uma reserva pendente será liberada.</p><button type="button" className="secondary" onClick={()=>setAction('')}>Voltar</button></ActionForm>}
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
  const [project, setProject] = useState(''),
    [center, setCenter] = useState(''),
    [contract, setContract] = useState('')
  const [range,setRange]=useState({start:'',end:''})
  const movements=data.movements.filter(m=>within(m.created_at,range))
  const groups = expenseGroups(data.requests.filter(request => within(request.closed_at,range)))
  const sum = (list, fn) => list.reduce((s, x) => s + fn(x), 0)
  const movementValue = (kind) =>
    sum(
      movements.filter((m) => m.kind === kind),
      (m) => m.qty * Math.round(Number(m.price) * 100),
    ) / 100
  const groupValue = (d) =>
    sum(
      groups.filter((g) => g.destination === d),
      (g) => g.cents,
    ) / 100
  const scoped = groups.filter(
    (g) =>
      (!project || g.project === project) &&
      (!center || g.center === center) &&
      (!contract || g.contract === contract),
  )
  return (
    <>
      <Panel
        title="Movimentação financeira"
        className="epi-finance-hero"
        action={<DateRange value={range} onChange={setRange} compact />}
      >
        <div className="epi-metrics">
          {[
            ['Entradas de material', movementValue('Entrada'), 'neutral'],
            ['Saídas por entrega', movementValue('Saída'), 'neutral'],
            ['Despesas dos projetos', groupValue('Projeto'), 'rose'],
            [
              'Saldo financeiro em estoque · SSMA',
              sum(
                data.materials,
                (m) => m.qty * Math.round(m.price * 100),
              ) / 100,
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
        <CostBreakdown requests={data.requests.filter(q=>within(q.closed_at,range))}/>
      </div>
      <Panel title="Despesas por projeto e material">
        <div className="epi-filters epi-three-col">
          {[
            ['Projeto / unidade', 'project', project, setProject],
            ['Centro de custo', 'center', center, setCenter],
            ['Contrato', 'contract', contract, setContract],
          ].map(([label, k, v, set]) => (
            <Select
              key={k}
              label={label}
              placeholder="Todos"
              value={v}
              options={[...new Set(groups.map((g) => g[k]).filter(Boolean))]}
              onChange={(e) => set(e.target.value)}
            />
          ))}
        </div>
        <Table
          headers={[
            'Destino do custo',
            'Projeto atendido',
            'UF',
            'Centro de custo',
            'Contrato',
            'Material / grade',
            'Entregue',
            'Despesa',
          ]}
          rows={scoped.map((g) => [
            g.destination,
            g.project,
            g.state ? <span className="uf-pill">{g.state}</span> : '—',
            g.center || '—',
            g.contract || '—',
            g.material,
            <span className="num-cell">{g.qty}</span>,
            <strong className="money-strong">{money(g.cents / 100)}</strong>,
          ])}
          empty="Nenhuma entrega confirmada para este filtro."
        />
        {!!scoped.length && (
          <p className="epi-total">
            Total selecionado <strong>{money(sum(scoped, (g) => g.cents) / 100)}</strong>
          </p>
        )}
      </Panel>
      <Panel title="Extrato de entradas e saídas">
        <Table
          headers={['Data', 'Movimento', 'Material', 'Quantidade', 'Valor unitário', 'Valor total']}
          rows={movements.map((m) => [
            stamp(m.created_at),
            <span className={'badge ' + (m.kind === 'Entrada' ? 'green' : 'gray')}>{m.kind}</span>,
            <strong className="material-strong">{variant(m.material_label || data.materials.find((i) => i.id === m.material_id) || { name: 'Material excluído' })}</strong>,
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
        <ActionForm
          submit="Registrar equipamento"
          onSave={(p) => save('asset', p)}
          onDone={() => setDelivery('')}
        >
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
                  data.assets.filter((a) => a.request_id === delivery && a.material_id === i.material_id)
                    .length < i.qty,
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
