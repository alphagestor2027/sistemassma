import {usePages} from './Pagination'
import {CostBreakdown, DateRange, within} from './EpiReports'
import React, { useState } from 'react'
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

export function Requests({ data, profile, save, refresh, initialFocus }) {
  const [status, setStatus] = useState('')
  const [focused,setFocused]=useState(initialFocus)
  const list = data.requests.filter(q => (!status || q.status === status)&&(!focused||q.id===focused))
  const pages=usePages(list.flatMap(q=>q.items.map(item=>({q,item}))),status)
  const visible=new Map()
  for(const {q,item} of pages.items){
    if(!visible.has(q.id)) visible.set(q.id,{...q,items:[],complete:q.items})
    visible.get(q.id).items.push(item)
  }
  return (
    <Panel
      title="Solicitações dos colaboradores"
      action={
        <button className="secondary" onClick={refresh}>
          Atualizar solicitações
        </button>
      }
    >
      <div className="epi-filters">
        {focused&&<button className="secondary" onClick={()=>setFocused(null)}>Ver todas as solicitações</button>}
        <Select
          label="Situação"
          placeholder="Todas"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          options={['Solicitado', 'Entregue', 'Cancelado']}
        />
      </div>
      {[...visible.values()].map((q) => {
        const reg = data.regions.find((r) => r.id === q.region_id)
        return (
          <article className="epi-request" key={q.id}>
            <header>
              <div>
                <strong>{q.employee}</strong>
                <small>
                  {q.project} · {q.state} · {q.job} · {stamp(q.created_at)}
                </small>
              </div>
              <span
                className={
                  'badge ' + (q.status === 'Entregue' ? 'green' : q.status === 'Solicitado' ? 'red' : 'gray')
                }
              >
                {q.status}
              </span>
            </header>
            <p>{q.items.map((i) => i.qty + ' × ' + variant(i)).join(', ')}</p>
            {q.complete.length>q.items.length&&<details><summary>Ver solicitação completa ({q.complete.length} itens)</summary>
              <p>{q.complete.map(i=>i.qty+' × '+variant(i)).join(', ')}</p></details>}
            <small>
              Rastreio {q.tracking_code} · Técnico responsável: {q.technician || reg?.technician}
            </small>
            <p>
              Andamento: <strong>{q.status === 'Solicitado' ? q.stage : q.status}</strong>
              {q.postal && ' · Correios: ' + q.postal}
            </p>
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
            {q.status === 'Solicitado' ? (
              <div className="epi-request-actions">
                {!q.employee_removed && (profile.is_master || reg?.id === (profile.stock_unit || profile.user_id)) && (
                  <ActionForm
                    submit="Confirmar entrega"
                    onSave={(p) => save('deliver', { ...p, request_id: q.id })}
                  >
                    <p>Despesa da entrega: {q.project}</p>
                  </ActionForm>
                )}
                <details>
                  <summary>Cancelar solicitação</summary>
                  <p>A reserva dos materiais será liberada.</p>
                  <ActionForm
                    submit="Confirmar cancelamento"
                    onSave={() => save('cancel', { request_id: q.id })}
                  />
                </details>
              </div>
            ) : (
              <small>
                {q.confirmed_name} · {stamp(q.closed_at)}
                {q.destination && ' · Custo do ' + q.destination}
              </small>
            )}
          </article>
        )
      })}
      {pages.controls}
      {!list.length && <p className="epi-empty">Nenhuma solicitação para os filtros selecionados.</p>}
    </Panel>
  )
}

export function Finance({ data }) {
  const [project, setProject] = useState(''),
    [center, setCenter] = useState(''),
    [contract, setContract] = useState('')
  const [range,setRange]=useState({start:'',end:''})
  const movements=data.movements.filter(m=>within(m.created_at,range))
  const groups = expenseGroups(data.requests.filter(request => !request.finance_cleared && within(request.closed_at,range)))
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
      <Panel title="Movimentação financeira">
        <DateRange value={range} onChange={setRange}/>
        <div className="epi-metrics">
          {[
            ['Entradas de material', movementValue('Entrada')],
            ['Saídas por entrega', movementValue('Saída')],
            ['Despesas dos projetos', groupValue('Projeto')],
            [
              'Saldo financeiro em estoque · SSMA',
              sum(
                data.materials,
                (m) => m.qty * Math.round(m.price * 100),
              ) / 100,
            ],
            ['Entregas históricas ao SSMA', groupValue('SSMA')],
          ].map(([label, v]) => (
            <div key={label}>
              <small>{label}</small>
              <strong>{money(v)}</strong>
            </div>
          ))}
        </div>
      </Panel>
      <CostBreakdown requests={data.requests.filter(q=>within(q.closed_at,range))}/>
      <Panel title="Despesas por projeto e material">
        <div className="epi-filters">
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
            g.state,
            g.center || '—',
            g.contract || '—',
            g.material,
            g.qty,
            money(g.cents / 100),
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
            m.kind,
            variant(m.material_label || data.materials.find((i) => i.id === m.material_id) || { name: 'Material excluído' }),
            m.qty,
            money(m.price),
            money(m.qty * m.price),
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
