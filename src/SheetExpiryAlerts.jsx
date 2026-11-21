import React, {useEffect,useState} from 'react'
import {rpc} from './EpiShared'
import {stamp} from './epiData'

export function SheetExpiryAlerts({db,open}) {
  const [docs,setDocs]=useState([]),[error,setError]=useState('')
  useEffect(()=>{
    let active=true,revision=0
    async function check(){
      const n=++revision
      try{const result=await rpc(db,'sheet',{action:'expiring',p:{}})
        if(active && n===revision){setDocs(result);setError('')}
      }catch(e){if(active && n===revision)setError(e.message)}
    }
    check()
    const timer=setInterval(check,60000)
    window.addEventListener('focus',check)
    return ()=>{active=false;clearInterval(timer);window.removeEventListener('focus',check)}
  },[db])
  if(error)return <p className="notice error" role="alert">Falha ao consultar vencimentos de fichas. {error}</p>
  if(!docs?.length)return null
  return <section className="notice" role="status"><div><strong>Fichas de EPI com exclusão nas próximas 72 horas</strong>
    <ul>{docs.map(s=><li key={s.number}>Ficha nº {s.number} · {s.employee} · exclusão em {stamp(s.expires_at)}</li>)}</ul>
    <button className="secondary" onClick={open}>Abrir ficha digital para salvar PDF</button></div></section>
}
