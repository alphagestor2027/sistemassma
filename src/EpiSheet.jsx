import React, { useEffect, useRef, useState } from 'react'
import { Field, Panel, Select, rpc } from './EpiShared'
import { ReplacementAlert } from './EpiIndicators'
import { defaultSettings, identityFields, SheetDocument } from './EpiSheetDocument'
import { SheetMaterials,deliveryReasons } from './SheetMaterials'
import { stamp } from './epiData'

async function squareLogo(file) {
  if (!['image/png','image/jpeg','image/webp'].includes(file.type)) throw Error('Escolha uma imagem PNG, JPEG ou WebP.')
  if (file.size > 10 * 1024 * 1024) throw Error('Escolha uma imagem de até 10 MB.')
  const image = await createImageBitmap(file)
  try {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 256
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#fff'
    ctx.fillRect(0,0,256,256)
    const scale = 256 / Math.max(image.width,image.height)
    const w = image.width * scale, h = image.height * scale
    ctx.drawImage(image,(256-w)/2,(256-h)/2,w,h)
    return canvas.toDataURL('image/png')
  } finally { image.close() }
}

function EmployeeSheets({db,id,profile,delivered,onIssued,archiveId,onArchiveDeleted}) {
  const [context,setContext] = useState(null), [doc,setDoc] = useState(null), [settings,setSettings] = useState(null)
  const [mode,setMode] = useState('new'), [busy,setBusy] = useState(false), [error,setError] = useState('')
  const [confirm,setConfirm] = useState(false), [template,setTemplate] = useState(false), [reload,setReload] = useState(0)
  const [items,setItems]=useState([])
  const newId = useRef(crypto.randomUUID())
  const lock = useRef(false)
  const api = (action,p={}) => rpc(db,'sheet',{action,p:{employee_id:id,...p}})
  useEffect(() => {
    let current = true
    setBusy(true)
    setError('')
    rpc(db,'sheet',{action:archiveId?'open':'context',p:{employee_id:id,id:archiveId}}).then(value => {
      if (!current) return
      if (archiveId) {
        setContext({sheets:[value]})
        view(value)
        return
      }
      setContext(value)
      setDoc(null)
      setMode('new');setItems([])
      setConfirm(false)
      setTemplate(false)
      newId.current = crypto.randomUUID()
      setSettings(defaultSettings(value.snapshot,value.template))
    }).catch(e => {if(current) setError(e.message)}).finally(() => {if(current) setBusy(false)})
    return () => {current=false}
  },[db,id,reload,archiveId])
  async function run(fn) {
    if(lock.current) return
    lock.current=true
    setBusy(true)
    setError('')
    try {await fn()} catch(e) {setError(e.message || 'Não foi possível concluir.')} finally {lock.current=false;setBusy(false)}
  }
  function view(value) {
    setDoc(value);setSettings(value.settings);setMode('view');setConfirm(false);setTemplate(false)
  }
  function save() {
    return run(async () => {
      const value = await api(mode==='new'?'issue':'edit',{
        id:doc?.id || newId.current, revision:doc?.revision, version:context.version, settings, save_template:template, ...(mode==='new'?{new_items:items}:{}),
      })
      setContext(previous => ({...previous,sheets:[value,...previous.sheets.filter(s=>s.id!==value.id)]}))
      view(value)
      if(mode==='new') onIssued?.()
    })
  }
  const field = (key,value) => setSettings(current => ({...current,[key]:value}))
  const snapshot = doc?.snapshot || context?.snapshot
  return <>
    {error && <div role="alert" className="notice error">{error} <button className="secondary" disabled={busy} onClick={()=>setReload(n=>n+1)}>Recarregar fichas</button></div>}
    {busy && !context && <p role="status">Carregando fichas…</p>}
    {context && settings && <>
      <Panel title="Fichas emitidas">
        <div className="epi-filters">
          {!archiveId && <Select label="Abrir ficha" options={context.sheets.map(s=>[s.id,'Nº '+s.number+' · '+stamp(s.issued_at)])}
            placeholder="Nova ficha" value={doc?.id || ''} disabled={busy} onChange={e=>{
              const key=e.target.value
              if(key) run(async()=>view(await api('open',{id:key})))
              else setReload(n=>n+1)
            }}/>}
          {mode==='view' && <>
            <button className="secondary" disabled={busy} onClick={()=>setMode('edit')}>Editar ficha</button>
            <button className="secondary" disabled={busy} onClick={()=>setConfirm(true)}>Excluir ficha</button>
            <button className="primary" disabled={busy} onClick={()=>window.print()}>Imprimir ficha / salvar PDF</button>
          </>}
        </div>
        {doc?.expires_at && <p>Exclusão programada para {stamp(doc.expires_at)}.</p>}
        {confirm && <div className="notice"><p>Excluir a ficha nº {doc.number}? As entregas continuarão no histórico do colaborador.</p>
          <button className="secondary" disabled={busy} onClick={()=>setConfirm(false)}>Cancelar</button>{' '}
          <button className="primary" disabled={busy} onClick={()=>run(async()=>{await api('delete',{id:doc.id,revision:doc.revision});if(archiveId) onArchiveDeleted(); else setReload(n=>n+1)})}>Confirmar exclusão</button>
        </div>}
      </Panel>
      <ReplacementAlert requests={delivered}/>
      {mode!=='view' && <Panel title={mode==='edit'?'Editar ficha nº '+doc.number:'Nova ficha de EPI'}>
        <form className="fepi-editor" onSubmit={e=>{e.preventDefault();save()}}>
          <fieldset disabled={busy}>
            {mode==='new' && <SheetMaterials materials={context.materials || []} items={items} setItems={setItems} project={snapshot.unit}/>}

            <details><summary>Identificação da empresa e do colaborador</summary><div className="fepi-grid">
              {identityFields.map(([key,label])=><Field key={key} label={label} readOnly={key==='unit' && (items.length>0 || doc?.snapshot.items.some(i=>i.reason))} maxLength={254} value={settings.identity[key]}
                onChange={e=>field('identity',{...settings.identity,[key]:e.target.value})}/>)}
            </div></details>
            <details><summary>Logo e textos da ficha</summary>
              <Field label="Logo da empresa (1:1)" type="file" accept="image/png,image/jpeg,image/webp"
                onChange={e=>{const file=e.target.files?.[0];e.target.value='';if(file) run(async()=>field('logo',await squareLogo(file)))}}/>
              {settings.logo && <div className="fepi-logo-preview"><img alt="Logo selecionada" src={settings.logo}/>
                <button type="button" className="secondary" onClick={()=>field('logo','')}>Remover logo</button></div>}
              <label>Fundamentação legal<textarea aria-label="Fundamentação legal" rows={8} value={settings.legal} maxLength={20000} onChange={e=>field('legal',e.target.value)}/></label>
              <label>Termo de responsabilidade<textarea aria-label="Termo de responsabilidade" rows={5} value={settings.term} maxLength={20000} onChange={e=>field('term',e.target.value)}/></label>
              {profile.is_master && (snapshot.company||snapshot.cnpj) && <label className="epi-check"><input type="checkbox" checked={template} onChange={e=>setTemplate(e.target.checked)}/> Usar esta logo e estes textos nas próximas fichas desta empresa</label>}
            </details>
            {snapshot.items.length>0 && <details><summary>Motivo de cada entrega</summary><div className="fepi-grid">
              {snapshot.items.map(i=><Select options={[...new Set([...deliveryReasons,...(settings.reasons[i.key]?[settings.reasons[i.key]]:[])])]} key={i.key} label={i.date.split('-').reverse().join('/')+' · '+i.equipment} placeholder="Motivo da entrega" value={settings.reasons[i.key] || ''} maxLength={300}
                onChange={e=>field('reasons',{...settings.reasons,[i.key]:e.target.value})}/>)}
            </div></details>}
            <Field label="Local de assinatura" value={settings.place} maxLength={200} onChange={e=>field('place',e.target.value)}/>
            <div className="button-group">
              <button className="primary" disabled={busy || !settings.term.trim() || !settings.legal.trim()}>{mode==='new'?'Emitir ficha':'Salvar alterações da ficha'}</button>
              {mode==='edit' && <button className="secondary" type="button" onClick={()=>view(doc)}>Cancelar edição</button>}
            </div>
          </fieldset>
        </form>
      </Panel>}
      <SheetDocument snapshot={snapshot} settings={settings} number={doc?.number} issuedAt={doc?.issued_at}/>
    </>}
  </>
}

export function Sheet({ db, data, profile,onIssued }) {
  const [id,setId]=useState('')
  const [people,setPeople]=useState([]), [error,setError]=useState(''), [attempt,retry]=useState(0)
  const [archive,setArchive]=useState([]), [archiveId,setArchiveId]=useState('')
  const archivedSheet=archive.find(s=>s.id===archiveId)
  useEffect(()=>{
    let current=true
    const refresh=()=>retry(n=>n+1)
    window.addEventListener('focus',refresh)
    Promise.all([rpc(db,'sheet',{action:'employees',p:{}}),profile.is_master?rpc(db,'sheet',{action:'archived',p:{}}):[]]).then(([list,docs])=>{
      if(current){
        setPeople(list);setArchive(docs);setError('')
        setId(selected=>list.some(e=>e.id===selected)?selected:'')
        setArchiveId(selected=>docs.some(d=>d.id===selected)?selected:'')
      }
    }).catch(e=>{if(current)setError(e.message)})
    return ()=>{current=false;window.removeEventListener('focus',refresh)}
  },[db,attempt,profile.is_master])
  return <>
    <Panel title="Ficha de EPI digital"><p>As fichas são excluídas permanentemente dois anos após a emissão. Salve o PDF em um local seguro. O painel avisa nas últimas 72 horas.</p><Select label="Consultar colaborador" value={id}
      options={people.map(e=>[e.id,e.name])} onChange={e=>{setId(e.target.value);setArchiveId('')}}/>
      {archive.length>0 && <Select label="Fichas emitidas de cadastros removidos" value={archiveId}
        options={archive.map(s=>[s.id,'Nº '+s.number+' · '+stamp(s.issued_at)])}
        onChange={e=>{setArchiveId(e.target.value);setId('')}}/>}</Panel>
    {error && <p className="notice error" role="alert">{error} <button onClick={()=>retry(attempt+1)}>Tentar novamente</button></p>}
    {id && <EmployeeSheets key={id} db={db} id={id} profile={profile} onIssued={onIssued}
      delivered={data.requests.filter(q=>q.employee_id===id && q.status==='Entregue')}/>}
    {archivedSheet && <EmployeeSheets key={archiveId} db={db} id={archivedSheet.employee_id} profile={profile} archiveId={archiveId}
      delivered={[]} onArchiveDeleted={()=>{setArchiveId('');retry(n=>n+1)}}/>}
  </>
}
