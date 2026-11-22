import React,{useState} from 'react'
import {Select,Field,Table} from './EpiShared'

export const deliveryReasons=['Inicial','Substituição por perda ou roubo','Substituição por período de troca/desgaste']

function normalize(value) {
  return value.normalize('NFD').replace(/\p{M}/gu,'').toLocaleLowerCase('pt-BR').trim()
}

function materialLabel(material) {
  const ca = material.ca ? 'CA '+material.ca : 'Sem CA'
  const aliases = material.generic_cas?.length ? ' · CAs genéricos: '+material.generic_cas.join(', ') : ''
  return material.name+' · '+ca+aliases+' · '+material.available+' disponíveis'
}

export function SheetMaterials({materials,items,setItems,project,documentOnly}) {
  const [id,setId]=useState(''),[qty,setQty]=useState('1'),[reason,setReason]=useState('')
  const [search,setSearch]=useState('')
  const term=normalize(search)
  const remaining=term ? materials.filter(m=>!items.some(i=>i.id===m.id) && normalize([m.name,m.ca,...(m.generic_cas||[])].join(' ')).includes(term)) : []
  const selected=remaining.length===1 ? remaining[0] : remaining.find(m=>m.id===id)
  function include(){
    setItems([...items,{id:selected.id,qty:Number(qty),reason}])
    setSearch('');setId('');setQty('1');setReason('')
  }
  return <section><h3>Materiais para entrega</h3>
    {materials.length>0?<>{documentOnly?<p>As alterações abaixo atualizam os itens do documento.</p>:<p>A emissão confirma a baixa no estoque do SSMA e lança o custo no projeto {project}.</p>}
      <Field label="Buscar material ou CA" type="search" value={search} onChange={e=>{setSearch(e.target.value);setId('')}}/>
      {term && <div aria-live="polite">
        {selected && <p>{materialLabel(selected)}</p>}
        {!remaining.length && <p>Nenhum material disponível para esta busca.</p>}
        {remaining.length>1 && <fieldset><legend>Escolha o material</legend>{remaining.map(m=><label key={m.id} style={{display:'block'}}>
          <input type="radio" name="sheet-material" checked={m.id===id} onChange={()=>setId(m.id)}/> {materialLabel(m)}
        </label>)}</fieldset>}
      </div>}
      <div className="epi-filters">
      <Field label="Quantidade para entrega" type="number" min={1} step={1} max={selected?.available} value={qty} onChange={e=>setQty(e.target.value)}/>
      <Select label="Motivo da entrega" options={deliveryReasons} value={reason} onChange={e=>setReason(e.target.value)}/>
      <button className="secondary" type="button" disabled={!selected || !reason || !Number.isInteger(Number(qty)) || Number(qty)<1 || Number(qty)>selected.available} onClick={include}>Incluir material na ficha</button></div></>:
      <p>Nenhum material disponível para entrega. Confira o projeto do colaborador, o técnico responsável e o saldo disponível.</p>}
    {items.length>0 && <Table headers={['Material','Quantidade','Motivo','Ações']} rows={items.map(i=>[materials.find(m=>m.id===i.id)?.name,i.qty,i.reason,
      <button type="button" className="secondary" onClick={()=>setItems(items.filter(item=>item.id!==i.id))}>Retirar da ficha</button>])}/>}
  </section>
}
