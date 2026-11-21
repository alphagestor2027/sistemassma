import React,{useEffect,useState} from 'react'
import {ActionForm,Field,Panel,Select,Table,rpc} from './EpiShared'
import {DateRange,within,totalsBy} from './EpiReports'
import {PriceField} from './PriceField'
import {money,regionOf,states,variant} from './epiData'
import {dateLabel,today} from './data'
import {Skeleton} from './Skeleton'

function InvoiceItem({index,materials,onRemove,item={}}) {
  const [ca,setCa]=useState(item.ca||''),[noCa,setNoCa]=useState(Boolean(item.no_ca)),[id,setId]=useState(item.material_id||''),[glove,setGlove]=useState(false)
  const opts=materials.filter(m=>noCa?!m.ca:ca.trim()&&m.ca&&m.ca.replace(/^0+/, '')===ca.trim().replace(/^0+/, ''))
  return <div className="invoice-item"><h3>Item {index+1}</h3>
    <div className="epi-filters">
      <Field label="CA" name={'ca'+index} value={ca} required={!noCa} disabled={noCa} pattern="[0-9]+" onChange={e=>{const value=e.target.value;setCa(value)
        const found=materials.filter(m=>m.ca&&m.ca.replace(/^0+/,'')===value.trim().replace(/^0+/,''));setId(found.length===1?found[0].id:'')}}/>
      <label><input type="checkbox" name={'no_ca'+index} checked={noCa} onChange={e=>{setNoCa(e.target.checked);setCa('');setId('')}}/> Material sem CA</label>
      <Select label="Material e grade" name={'material_id'+index} placeholder="Cadastrar novo item" options={[...opts.map(m=>[m.id,variant(m)]),...(id===item.material_id&&!opts.some(m=>m.id===id)?[[id,variant(item)]]:[])]} value={id} onChange={e=>setId(e.target.value)}/>
      {!id&&<><Field label="Nome do material" name={'name'+index} required maxLength={180}/><Field label="Cor" name={'color'+index} maxLength={60}/>
        <Field label="Tamanho" name={'size'+index} maxLength={60}/><label><input type="checkbox" name={'glove'+index} checked={glove} onChange={e=>setGlove(e.target.checked)}/> Luva isolante</label>
        <Field label="Início do certificado ou ensaio da luva" name={'glove_start'+index} type="date" required={glove}/></>}
      <Field label="Quantidade" type="number" step="1" min="1" name={'qty'+index} defaultValue={item.qty} required/>
      <PriceField name={'price'+index} initialValue={item.price} label="Valor unitário" required/>
    </div>{onRemove&&<button type="button" className="text-button" onClick={onRemove}>Remover item</button>}
  </div>
}
function InvoiceForm({materials,save,unit,editing}) {
  const [keys,setKeys]=useState(()=>editing?editing.items.map((_,i)=>i):[0]),[next,setNext]=useState(editing?.items.length||1)
  return <ActionForm submit={editing?'Salvar alterações da nota':'Registrar nota e dar entrada no estoque'} onSave={p=>{
    const items=keys.map((_,i)=>Object.fromEntries(['ca','no_ca','name','material_id','color','size','qty','price','glove','glove_start'].map(k=>[k,['no_ca','glove'].includes(k)?Boolean(p[k+i]):p[k+i]||''])))
    return save({id:p.id,number:p.number,series:p.series,cnpj:p.cnpj,date:p.date,unit_id:unit,items})
  }}>
    <Field label="CNPJ do fornecedor" name="cnpj" defaultValue={editing?.cnpj} required maxLength={18}/><Field label="Número da nota fiscal" name="number" defaultValue={editing?.number} required maxLength={40}/>
    <Field label="Série" name="series" defaultValue={editing?.series} maxLength={12}/><Field label="Data de emissão" type="date" name="date" required defaultValue={editing?.issued||today()}/>
    <div className="invoice-lines">{keys.map((k,i)=><InvoiceItem key={k} index={i} item={editing?.items[k]} materials={materials} onRemove={keys.length>1?()=>setKeys(keys.filter(x=>x!==k)):undefined}/>)}
      <button type="button" className="secondary" disabled={keys.length>=100} onClick={()=>{setKeys([...keys,next]);setNext(next+1)}}>Adicionar item</button></div>
  </ActionForm>
}
function ShippingForm({employees,profile,unit,save,editing}) {
  const [employee,setEmployee]=useState(employees.some(e=>e.id===editing?.employee_id)?editing.employee_id:'')
  const selected=employees.find(e=>e.id===employee)
  return <ActionForm submit={editing?'Salvar alterações do envio':'Registrar envio'} onSave={p=>save({...p,unit_id:unit})}>
    <Field label="Data de envio" type="date" name="date" required defaultValue={editing?.sent||today()}/>
    <Field label="Código de rastreamento" name="tracking" defaultValue={editing?.tracking} required minLength={4} maxLength={64}/>
    <Select label="Modalidade de entrega" name="mode" defaultValue={editing?.mode} required options={['PAC','SEDEX','SEDEX 10','SEDEX 12','SEDEX Hoje','Mini Envios','Carta registrada','Outra']}/>
    <Select label="Colaborador cadastrado" name="employee_id" placeholder="Outro destinatário ou empresa" options={employees.map(e=>[e.id,e.name+' · '+e.project])} value={employee} onChange={e=>setEmployee(e.target.value)}/>
    {selected?<p>{selected.project} · {regionOf(selected.state)} · {selected.state}</p>:<>
      <Field label="Nome do destinatário ou empresa" name="recipient" defaultValue={editing?.recipient} required maxLength={200}/>
      <Field label="Projeto" name="project" defaultValue={editing?.project} required maxLength={120}/>
      <Select label="UF de destino" name="state" defaultValue={editing?.state} required options={profile.is_master?states:profile.coverage||[]}/></>}
    <PriceField label="Valor do envio" initialValue={editing?.cost} required/>
  </ActionForm>
}
export function Logistics({db,profile,shipping=false,onSaved}) {
  const [data,setData]=useState(null),[error,setError]=useState(''),[form,setForm]=useState(false),[choice,setChoice]=useState(''),[revision,setRevision]=useState(0)
  const [editing,setEditing]=useState(null),[confirm,setConfirm]=useState(null),[removing,setRemoving]=useState(false),[mutationError,setMutationError]=useState('')
  const [range,setRange]=useState({start:'',end:''}),[notice,setNotice]=useState('')
  useEffect(()=>{
    let active=true
    setError('')
    rpc(db,'logistics',{action:shipping?'shipments':'invoices',p:{}}).then(d=>{if(active)setData(d)}).catch(e=>{if(active)setError(e.message)})
    return ()=>{active=false}
  },[db,shipping,revision])
  const unit=editing?.unit_id||(profile.is_master?(choice||(data?.units.length===1?data.units[0].id:'')):(profile.stock_unit||profile.user_id))
  async function save(p) {
    const action=(editing?'edit_':'')+(shipping?'ship':'invoice')
    await rpc(db,'logistics',{action,p:editing?{...p,id:editing.id,previous:editing.request_hash}:p})
    setForm(false);setEditing(null);setNotice(shipping?'Envio salvo.':'Nota salva e estoque atualizado.');setRevision(n=>n+1);onSaved?.()
  }
  async function remove(){
    if(removing||!confirm)return
    setRemoving(true);setMutationError('')
    try{
      await rpc(db,'logistics',{action:shipping?'delete_ship':'delete_invoice',p:{id:confirm.id,unit_id:confirm.unit_id,previous:confirm.request_hash}})
      setConfirm(null);setNotice(shipping?'Envio excluído.':'Nota excluída e estoque atualizado.');setRevision(n=>n+1);onSaved?.()
    }catch(err){setMutationError(err.message)}finally{setRemoving(false)}
  }
  function actions(row){return <div className="button-group">
    <button className="secondary" disabled={removing} onClick={()=>{setEditing(row);setForm(true);setConfirm(null);setNotice('');setMutationError('')}}>Editar</button>
    <button className="secondary" disabled={removing} onClick={()=>{setConfirm(row);setForm(false);setEditing(null);setNotice('');setMutationError('')}}>Excluir</button></div>}
  if(error) return <p role="alert">{error} <button className="secondary" onClick={()=>setRevision(n=>n+1)}>Tentar novamente</button></p>
  if(!data) return <Skeleton label="Carregando lançamentos…"/>
  const rows=data.rows.filter(r=>within(shipping?r.sent:r.issued,range))
  return <Panel title={shipping?'Envios pelos Correios':'Notas fiscais de entrada'} action={<button className="primary" onClick={()=>{setEditing(null);setConfirm(null);setForm(!form);setNotice('');setMutationError('')}}>{form?'Fechar cadastro':shipping?'Cadastrar envio':'Inserir nota fiscal'}</button>}>
    {notice&&<p role="status">{notice}</p>}
    {mutationError&&<p role="alert" className="form-error">{mutationError}</p>}
    {confirm&&<div className="notice"><p>{shipping?'Excluir o envio '+confirm.tracking+' e descontar seu frete dos totais?':'Excluir a nota '+confirm.number+' e descontar seus itens do estoque?'}</p>
      <button className="secondary" disabled={removing} onClick={()=>setConfirm(null)}>Cancelar</button>
      <button className="primary" disabled={removing} onClick={remove}>Confirmar exclusão</button></div>}
    {form&&<>{profile.is_master&&!editing&&<Select label="Estoque do lançamento" value={unit} onChange={e=>setChoice(e.target.value)} options={data.units.map(u=>[u.id,u.name])}/>}
      {unit&&(shipping?<ShippingForm key={editing?.id||unit} editing={editing} employees={data.employees.filter(e=>e.unit===unit)} profile={profile} unit={unit} save={save}/>:<InvoiceForm key={editing?.id||unit} editing={editing} unit={unit} materials={data.materials.filter(m=>m.region_id===unit)} save={save}/>)}</>}
    <DateRange value={range} onChange={setRange}/>
    {shipping?<><h3>Gasto com envios · {money(rows.reduce((v,s)=>v+Math.round(s.cost*100),0)/100)}</h3><div className="epi-split">
      <Table headers={['Região','Gasto com envios']} rows={totalsBy(rows,s=>regionOf(s.state),s=>Math.round(s.cost*100))}/>
      <Table headers={['Projeto','Gasto com envios']} rows={totalsBy(rows,s=>s.project,s=>Math.round(s.cost*100))}/></div>
      <Table headers={['Data','Rastreio','Destinatário','Projeto','UF','Modalidade','Valor','Ações']} rows={rows.map(s=>[dateLabel(s.sent),s.tracking,s.recipient,s.project,s.state,s.mode,money(s.cost),actions(s)])}/></>:
      <Table headers={['Emissão','Nota fiscal','Série','CNPJ','Itens','Valor total','Ações']} rows={rows.map(n=>[dateLabel(n.issued),n.number,n.series||'—',n.cnpj,n.items.length,money(n.total),actions(n)])}/>}
  </Panel>
}
