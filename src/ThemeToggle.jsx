import React,{useEffect,useState} from 'react'
import {Moon,Sun} from 'lucide-react'
import './theme.css'

const key='ssma-theme'
function preference(){
  try{const saved=localStorage.getItem(key);if(['dark','light'].includes(saved))return saved}catch{}
  return window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'
}
document.documentElement.dataset.theme=preference()

export function ThemeToggle(){
  const [theme,setTheme]=useState(preference)
  useEffect(()=>{
    const sync=()=>{const next=preference();document.documentElement.dataset.theme=next;setTheme(next)}
    const system=window.matchMedia('(prefers-color-scheme: dark)')
    window.addEventListener('storage',sync);system.addEventListener('change',sync)
    return ()=>{window.removeEventListener('storage',sync);system.removeEventListener('change',sync)}
  },[])
  const label=theme==='dark'?'Ativar modo claro':'Ativar modo escuro'
  return <button type="button" className="theme-toggle" aria-label={label} title={label} onClick={()=>{
    const next=theme==='dark'?'light':'dark'
    try{localStorage.setItem(key,next)}catch{}
    document.documentElement.dataset.theme=next;setTheme(next)
  }}>{theme==='dark'?<Sun size={18}/>:<Moon size={18}/>}</button>
}
