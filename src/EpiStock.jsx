import {usePages} from './Pagination'
import {PriceField} from './PriceField'
import React, { useState } from 'react'
import { CaExpiryEditor, CaResult, useCaLookup } from './CaCatalog'
import { Panel, ActionForm, Field, Select, Table, rpc } from './EpiShared'
import { available, variant, regionLabel, money, after365 } from './epiData'
import { dateLabel, today } from './data'

const materialColors = ['Amarelo', 'Azul', 'Azul-marinho', 'Bege', 'Branco', 'Cinza', 'Incolor', 'Laranja', 'Marrom', 'Multicolorido', 'Preto', 'Rosa', 'Roxo', 'Verde', 'Vermelho', 'Vinho', 'Outra',]
const numberProps = { type: 'number', min: 0, step: 1 }
export function Stock({ db, data, profile, save, initialFocus }) {
  const [noCA, setNoCA] = useState(false),
    [search, setSearch] = useState(()=>data.materials.find(m=>m.id===initialFocus)?.name||''),
    [show, setShow] = useState('')
  const [ca, setCa] = useState(''),
    [name, setName] = useState(null),
    [ficha, setFicha] = useState(0)
  const [selected, setSelected] = useState(null)
  const editing = show === 'edit' ? selected : null
  const formHeading = React.useRef(null)
  React.useEffect(() => {
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
  const fichaIndex = ficha ?? Math.max(0, lookup?.records?.findIndex(record=>record.sheet_key===editing?.ca_sheet_key) ?? 0)
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
  const [unit,setUnit]=useState('')
  const units=data.regions.filter(r=>r.distribution_unit).map(r=>[r.id,r.distribution_unit])
  const needsTechnician=profile.is_master && editing && !editing.region_id
  const [technicians,setTechnicians]=useState(null),[directoryError,setDirectoryError]=useState(''),[retryDirectory,setRetryDirectory]=useState(0)
  React.useEffect(()=>{
    if(!needsTechnician)return
    let active=true
    setTechnicians(null);setDirectoryError('')
    rpc(db,'manage',{action:'stock_technicians',p:{}}).then(list=>{if(active)setTechnicians(list)})
      .catch(err=>{if(active)setDirectoryError(err.message)})
    return ()=>{active=false}
  },[db,needsTechnician,retryDirectory])
  const [start, setStart] = useState(''),
    [manualGlove, setManualGlove] = useState(false)
  const detected = /luva.*isolante/i.test(name || '') || /luva.*isolante/i.test(suggested)
  const glove = detected || manualGlove
  const scopedMaterials=data.materials.filter(m=>!profile.is_master||!unit||m.region_id===unit)
  const materialOptions = scopedMaterials.map((m) => [
    m.id,
    variant(m) + ' · ' + regionLabel(data.regions.find((r) => r.id === m.region_id)),
  ])
  const materials = scopedMaterials.filter(
    (m) =>
      [variant(m), m.ca].join(' ').toLowerCase().includes(search.toLowerCase()),
  )
  const pages=usePages(materials,search+unit)
  return (
    <>
      <Panel
        title="Estoque de materiais"
        action={
          <div className="button-group">
            <button className="secondary" onClick={() => open('lookup')}>
              Consultar CA
            </button>
            <button className="secondary" onClick={() => open('entry')}>
              Registrar entrada
            </button>
            <button className="primary" onClick={() => open('new')}>
              Cadastrar material
            </button>
          </div>
        }
      >
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
          <h3 ref={formHeading} tabIndex={-1}>{editing ? 'Editar material' : 'Excluir material'} · {variant(selected)}</h3>
        )}
        {show === 'delete' && selected.reserved > 0 && <div className="notice" role="status">
          <p>Este material tem reservas. Conclua ou cancele os pedidos antes de excluí-lo.</p>
          <button type="button" className="secondary" onClick={() => setShow('')}>Fechar</button>
        </div>}
        {show === 'delete' && !selected.reserved && <ActionForm key={selected.id} submit="Confirmar exclusão"
          onSave={() => save('delete_material',{material_id:selected.id, revision:selected.revision})} onDone={() => setShow('')}
          >
          <p>O material será retirado do estoque. O histórico de movimentações e entregas será preservado.</p>
          {selected.qty > 0 && <p>Baixa de {selected.qty} unidade(s) no estoque.</p>}
          <button type="button" className="secondary" onClick={() => setShow('')}>Cancelar</button>
        </ActionForm>}
        {(show === 'new' || editing) && (
          <ActionForm key={editing?.id || 'new'}
            submit={editing ? 'Salvar alterações' : 'Salvar material'}
            onSave={(p) =>
              save(editing ? 'edit_material' : 'material', {
                ...p,
                ...(editing && {material_id:editing.id, revision:editing.revision, qty:p.qty || 0, minimum:p.minimum || 0, price:p.price || 0}),
                insulating_glove: glove,
                glove_start: glove ? start : null,
                no_ca: noCA,
                ...(!noCA && sheet && {ca_sheet_key:sheet.sheet_key}),
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
              label="CA"
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
                <Field label="Número da luva esquerda" name="glove_left_number" maxLength={100}
                  defaultValue={editing?.glove_left_number || ''} />
                <Field label="Número da luva direita" name="glove_right_number" maxLength={100}
                  defaultValue={editing?.glove_right_number || ''} />
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
            {profile.is_master && show==='new' && <Select label="Unidade do material" name="master_unit" defaultValue={unit} required options={units}/>}
            {needsTechnician && (directoryError?<p role="alert">{directoryError} <button type="button" className="secondary" onClick={()=>setRetryDirectory(n=>n+1)}>Tentar novamente</button></p>:
              technicians?.length===1?<><p>Estoque do técnico responsável · {technicians[0].name}</p>
                <input type="hidden" name="technician_id" value={technicians[0].id}/></>:
              <Select label="Técnico responsável pelo estoque" name="technician_id" options={(technicians || []).map(t=>[t.id,t.name])} required/>)}
            {needsTechnician && technicians?.length===0 && <p role="status">Conceda a permissão de estoque a um técnico em Gestão de técnicos.</p>}
            {editing && <button className="secondary" type="button" onClick={() => setShow('')}>Cancelar edição</button>}
          </ActionForm>
        )}
        {show === 'entry' && (
          <ActionForm submit="Confirmar entrada" onSave={(p) => save('entry', p)} onDone={() => setShow('')}>
            <Select label="Material" name="material_id" options={materialOptions} required />
            <Field label="Quantidade recebida" name="qty" type="number" min={1} required />
            <PriceField label="Valor unitário da entrada (R$)" placeholder="Usar o custo atual" />
          </ActionForm>
        )}
        <div className="epi-filters">
          {profile.is_master&&<Select label="Filtrar material por unidade" placeholder="Todas as unidades" value={unit} onChange={e=>setUnit(e.target.value)} options={units}/>}
          <Field
            label="Buscar material ou CA"
            type="search"
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
          rows={pages.items.map((m) => [
            variant(m),
            m.no_ca ? <span className="badge red">Sem CA</span> : m.ca,
            regionLabel(data.regions.find(r=>r.id===m.region_id)),

            available(m),
            m.minimum,
            <span className={'badge ' + (available(m) < m.minimum ? 'red' : 'green')}>{available(m) < m.minimum ? 'Comprar' : 'Ideal'}</span>,
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
              {m.ca_expiry && <div>CA · {m.ca_expiry}</div>}
              {m.expiry && <div className={m.expiry < today() ? 'red-text' : ''}>{m.insulating_glove ? 'Ensaio' : 'Lote'} · {dateLabel(m.expiry)}</div>}
              {!m.ca_expiry && !m.expiry && '—'}
            </div>,
            <div className="button-group">
              <button className="secondary" aria-label={'Editar ' + variant(m)} onClick={() => selectMaterial(m,'edit')}>Editar</button>
              <button className="secondary" aria-label={'Excluir ' + variant(m)} onClick={() => selectMaterial(m,'delete')}>Excluir</button>
            </div>,
          ])}
          empty="Nenhum material encontrado neste estoque."
        />
        {pages.controls}
      </Panel>
    </>
  )
}
