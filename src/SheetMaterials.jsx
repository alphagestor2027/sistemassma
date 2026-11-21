import React,{useState} from 'react'
import {Select,Field,Table} from './EpiShared'

export const deliveryReasons=['Inicial','Substituição por perda ou roubo','Substituição por período de troca/desgaste']

export function SheetMaterials({materials,items,setItems,project}) {
  const [id,setId]=useState(''),[qty,setQty]=useState('1'),[reason,setReason]=useState('')
  const remaining=materials.filter(m=>!items.some(i=>i.id===m.id))
  const selected=remaining.find(m=>m.id===id)
  function include(){
    setItems([...items,{id,qty:Number(qty),reason}])
    setId('');setQty('1');setReason('')
  }
  return <section><h3>Materiais para entrega</h3>
    {materials.length>0?<><p>A emissão confirma a baixa no estoque do SSMA e lança o custo no projeto {project}.</p>
      <div className="epi-filters"><Select label="Material de EPI" options={remaining.map(m=>[m.id,m.name+' · '+m.available+' disponíveis'])} value={id} onChange={e=>setId(e.target.value)}/>
      <Field label="Quantidade para entrega" type="number" min={1} step={1} max={selected?.available} value={qty} onChange={e=>setQty(e.target.value)}/>
      <Select label="Motivo da entrega" options={deliveryReasons} value={reason} onChange={e=>setReason(e.target.value)}/>
      <button className="secondary" type="button" disabled={!selected || !reason || !Number.isInteger(Number(qty)) || Number(qty)<1 || Number(qty)>selected.available} onClick={include}>Incluir material na ficha</button></div></>:
      <p>Nenhum material disponível para entrega. Confira o projeto do colaborador, o técnico responsável e o saldo disponível.</p>}
    {items.length>0 && <Table headers={['Material','Quantidade','Motivo','Ações']} rows={items.map(i=>[materials.find(m=>m.id===i.id)?.name,i.qty,i.reason,
      <button type="button" className="secondary" onClick={()=>setItems(items.filter(item=>item.id!==i.id))}>Retirar da ficha</button>])}/>}
  </section>
}
