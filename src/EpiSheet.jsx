import { Skeleton } from './Skeleton'
import React, { useEffect, useRef, useState } from 'react'
import { Field, Panel, Select, rpc } from './EpiShared'
import { ReplacementAlert } from './EpiIndicators'
import { defaultSettings, identityFields, SheetDocument } from './EpiSheetDocument'
import { SheetMaterials,deliveryReasons } from './SheetMaterials'
import { stamp } from './epiData'
import { Search, UserCheck } from 'lucide-react'

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

function EmployeeSheets({db,id,request,profile,delivered,onIssued,archiveId,onArchiveDeleted}) {
  const [context,setContext] = useState(null), [doc,setDoc] = useState(null), [settings,setSettings] = useState(null)
  const [mode,setMode] = useState('new'), [busy,setBusy] = useState(false), [error,setError] = useState('')
  const [confirm,setConfirm] = useState(false), [template,setTemplate] = useState(false), [reload,setReload] = useState(0)
  const [items,setItems]=useState([])
  const [message,setMessage]=useState('')
  const [removed,setRemoved]=useState([])
  const newId = useRef(crypto.randomUUID())
  const lock = useRef(false)
  const api = (action,p={}) => rpc(db,'sheet',{action,p:{employee_id:id,...p}})
  useEffect(() => {
    let current = true
    setBusy(true)
    setError('')
    rpc(db,'sheet',{action:archiveId?'open':'context',p:{employee_id:id,id:archiveId,request_id:request?.id}}).then(async value => {
      if (!current) return
      if (archiveId || value.issued) {
        value=value.issued || value
        const ctx=archiveId?{}:await rpc(db,'sheet',{action:'context',p:{employee_id:id}})
        if(!current)return
        setContext({...ctx,sheets:[value]})
        view(value)
        return
      }
      setContext(value)
      setDoc(null)
      setMode('new');setItems(value.draft?.items || []);setRemoved(value.draft?.removed || [])
      setConfirm(false)
      setTemplate(false)
      newId.current = crypto.randomUUID()
      setSettings(value.draft?.settings || defaultSettings(value.snapshot,value.template))
    }).catch(e => {if(current) setError(e.message)}).finally(() => {if(current) setBusy(false)})
    return () => {current=false}
  },[db,id,reload,archiveId,request?.id,request?.status])
  async function run(fn) {
    if(lock.current) return
    lock.current=true
    setBusy(true)
    setError('')
    try {await fn()} catch(e) {setError(e.message || 'Não foi possível concluir.')} finally {lock.current=false;setBusy(false)}
  }
  function view(value) {
    setItems([]);setRemoved([]);setDoc(value);setSettings(value.settings);setMode('view');setConfirm(false);setTemplate(false)
  }
  function save(draft=false) {
    return run(async () => {
      const value = await api(draft?'draft':mode==='new'?'issue':'edit',{
        id:doc?.id || newId.current, revision:doc?.revision, version:context.version, settings, save_template:template, ...(mode==='new' && !request?{new_items:items}:{document_items:items,removed}), request_id:mode==='new'?request?.id:undefined,
      })
      if(draft && !value.issued){setContext(value);setMessage('Rascunho salvo.');return}
      const saved=value.issued || value
      setContext(previous => ({...previous,sheets:[saved,...previous.sheets.filter(s=>s.id!==saved.id)]}))
      view(saved)
      if(mode==='new') onIssued?.()
    })
  }
  const field = (key,value) => setSettings(current => ({...current,[key]:value}))
  const baseSnapshot = doc?.snapshot || context?.snapshot
  const snapshot = baseSnapshot && {...baseSnapshot,items:baseSnapshot.items.filter(i=>!removed.includes(i.key))}
  const liveItems = (mode === 'new' && !request)
    ? items.map((it, idx) => {
        const mat = (context?.materials || []).find(m => m.id === it.id)
        return {
          key: 'draft-' + (it.id || idx),
          date: new Date().toISOString().slice(0, 10),
          ca: mat?.ca || '',
          equipment: mat?.name || 'Material',
          qty: it.qty,
          reason: it.reason
        }
      })
    : (snapshot?.items || [])
  const effectiveSnapshot = snapshot && {
    ...snapshot,
    items: liveItems
  }
  const effectiveReasons = {
    ...(settings?.reasons || {}),
    ...(mode === 'new' && !request ? Object.fromEntries(liveItems.map(i => [i.key, i.reason])) : {})
  }
  const effectiveSettings = settings && {
    ...settings,
    reasons: effectiveReasons
  }
  return <>
    {message && <p className="epi-success" role="status">{message}</p>}
    {error && <div role="alert" className="notice error">{error} <button className="secondary" disabled={busy} onClick={()=>setReload(n=>n+1)}>Recarregar fichas</button></div>}
    {busy && !context && <Skeleton label="Carregando fichas…"/>}
    {context && settings && <>
      <Panel title="Fichas emitidas">
        <div className="epi-filters">
          {!archiveId && !request && <Select label="Abrir ficha" options={context.sheets.map(s=>[s.id,'Nº '+s.number+' · '+stamp(s.issued_at)])}
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
        {confirm && <div className="notice"><p>Excluir a ficha nº {doc.number}? Os materiais selecionados voltarão para o estoque e os lançamentos financeiros serão estornados.</p>
          <button className="secondary" disabled={busy} onClick={()=>setConfirm(false)}>Cancelar</button>{' '}
          <button className="primary" disabled={busy} onClick={()=>run(async()=>{await api('delete',{id:doc.id,revision:doc.revision});onIssued?.();if(archiveId) onArchiveDeleted(); else setReload(n=>n+1)})}>Confirmar exclusão</button>
        </div>}
      </Panel>
      <ReplacementAlert requests={delivered}/>
      {mode!=='view' && <Panel title={<div style={{display:'flex',alignItems:'center',gap:'0.75rem',flexWrap:'wrap'}}>
          <span>{mode==='edit'?'Editar ficha nº '+doc.number:'Nova ficha de EPI'}</span>
          {mode==='new' && <span className="badge blue">Modo Rascunho</span>}
        </div>}>
        <form className="fepi-editor" onSubmit={e=>{e.preventDefault();save()}}>
          <fieldset disabled={busy}>
            {(mode==='new' || context.materials) && <SheetMaterials documentOnly={mode==='edit' || request?.status==='Entregue'} materials={context.materials || []} items={items} setItems={setItems} project={snapshot.unit}/>}

            {(request || mode==='edit') && snapshot.items.map(i=><p key={i.key}>{i.qty} × {i.equipment} <button type="button" className="secondary" onClick={()=>setRemoved(prev=>[...prev,i.key])}>Remover item</button></p>)}
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
              <button className="primary" disabled={busy || !settings.term.trim() || !settings.legal.trim()}>{mode==='new'?('Salvar ficha'):'Salvar alterações da ficha'}</button>
              {mode==='edit' && <button className="secondary" type="button" onClick={()=>view(doc)}>Cancelar edição</button>}
            </div>
          </fieldset>
        </form>
      </Panel>}
      <SheetDocument snapshot={effectiveSnapshot} settings={effectiveSettings} number={doc?.number} issuedAt={doc?.issued_at}/>
    </>}
  </>
}

export function Sheet({ db, data, profile,onIssued,sheetRequest,clearRequest }) {
  const [id,setId]=useState('')
  const [people,setPeople]=useState([]), [error,setError]=useState(''), [attempt,retry]=useState(0)
  const [archive,setArchive]=useState([]), [archiveId,setArchiveId]=useState('')
  const [search,setSearch]=useState('')
  const [showSuggestions,setShowSuggestions]=useState(false)
  const inputRef=useRef(null)
  const listRef=useRef(null)
  useEffect(()=>{if(sheetRequest){setId(sheetRequest.employee_id);setArchiveId('');setSearch('')}},[sheetRequest?.id])
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

  const norm=v=>v.normalize('NFD').replace(/\p{M}/gu,'').toLocaleLowerCase('pt-BR').trim()
  const term=norm(search)
  const filtered=term?people.filter(e=>norm(e.name).includes(term)):people
  const selectedPerson=people.find(e=>e.id===id)

  function selectPerson(person){
    clearRequest()
    setId(person.id)
    setSearch(person.name)
    setShowSuggestions(false)
    setArchiveId('')
  }

  // Close dropdown when clicking outside
  useEffect(()=>{
    function handleClick(e){
      if(inputRef.current&&!inputRef.current.contains(e.target)&&listRef.current&&!listRef.current.contains(e.target)){
        setShowSuggestions(false)
      }
    }
    document.addEventListener('mousedown',handleClick)
    return ()=>document.removeEventListener('mousedown',handleClick)
  },[])

  return <>
    {/* Autocomplete collaborator search */}
    <div className="epi-autocomplete-wrap">
      {sheetRequest && <div className="epi-autocomplete-request">
        <p>Ficha da solicitação <strong>{sheetRequest.tracking_code}</strong> · {sheetRequest.employee}</p>
        <button className="secondary" onClick={clearRequest}>Nova ficha manual</button>
      </div>}
      <p className="epi-autocomplete-hint">As fichas são excluídas permanentemente dois anos após a emissão. Salve o PDF em um local seguro.</p>
      <div className="epi-autocomplete">
        <div className="epi-autocomplete-input" ref={inputRef}>
          <Search size={16} className="epi-autocomplete-icon"/>
          <input
            type="text"
            placeholder="Digite o nome do colaborador…"
            value={search}
            onChange={e=>{setSearch(e.target.value);setShowSuggestions(true);if(!e.target.value.trim()){setId('');setArchiveId('')}}}
            onFocus={()=>setShowSuggestions(true)}
            autoComplete="off"
          />
        </div>
        {showSuggestions && search.trim() && filtered.length>0 && (
          <ul className="epi-autocomplete-list" ref={listRef} role="listbox">
            {filtered.slice(0,8).map(person=>(
              <li key={person.id} role="option" aria-selected={person.id===id}
                className={person.id===id?'selected':''}
                onClick={()=>selectPerson(person)}>
                <UserCheck size={16}/>
                <span>{person.name}</span>
              </li>
            ))}
            {filtered.length>8 && <li className="epi-autocomplete-more">+{filtered.length-8} resultados — refine a busca</li>}
          </ul>
        )}
        {showSuggestions && search.trim() && !filtered.length && (
          <div className="epi-autocomplete-empty">Nenhum colaborador encontrado.</div>
        )}
      </div>
      {selectedPerson && <div className="epi-selected-person">
        <UserCheck size={18}/>
        <div>
          <strong>{selectedPerson.name}</strong>
          <small>Colaborador selecionado</small>
        </div>
      </div>}
    </div>

    {archive.length>0 && <Select label="Fichas emitidas de cadastros removidos" value={archiveId}
      options={archive.map(s=>[s.id,'Nº '+s.number+' · '+stamp(s.issued_at)])}
      onChange={e=>{clearRequest();setArchiveId(e.target.value);setId('')}}/>}
    {error && <p className="notice error" role="alert">{error} <button onClick={()=>retry(attempt+1)}>Tentar novamente</button></p>}
    {id && <EmployeeSheets key={id+(sheetRequest?.id || '')} request={sheetRequest} db={db} id={id} profile={profile} onIssued={onIssued}
      delivered={data.requests.filter(q=>q.employee_id===id && q.status==='Entregue')}/>}
    {archivedSheet && <EmployeeSheets key={archiveId} db={db} id={archivedSheet.employee_id} profile={profile} archiveId={archiveId}
      delivered={[]} onArchiveDeleted={()=>{setArchiveId('');retry(n=>n+1)}}/>}
  </>
}
