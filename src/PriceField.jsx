import React, {useState} from 'react'
import {Field} from './EpiShared'

const format=new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'})
function normalizeDigits(value){
  return value.replace(/\D/g,'').replace(/^0+(?=\d)/,'')
}

export function PriceField({label,name='price',required=false,placeholder='R$ 0,00',initialValue}){
  const [digits,setDigits]=useState(()=>initialValue==null?'':String(Math.round(Number(initialValue)*100)))
  const cents=Number(digits)
  function change(value){
    const next=normalizeDigits(value)
    if(next.length<=14)setDigits(next)
  }
  function paste(event){
    event.preventDefault()
    const raw=event.clipboardData.getData('text').trim().replace(/^R\$\s*/,'')
    let amount
    if(/^(?:\d+|\d{1,3}(?:\.\d{3})+)(?:,\d{1,2})?$/.test(raw))amount=raw.replaceAll('.','').replace(',','.')
    else if(/^\d+\.\d{1,2}$/.test(raw))amount=raw
    if(amount!==undefined){
      const [whole,fraction='']=amount.split('.')
      change(whole+fraction.padEnd(2,'0'))
    }
  }
  return <>
    <Field label={label} required={required} inputMode="numeric" placeholder={placeholder} value={digits?format.format(cents/100):''}
      onChange={e=>change(e.target.value)} onPaste={paste}
      onKeyDown={e=>{if(digits==='0' && ['Delete','Backspace'].includes(e.key)){e.preventDefault();setDigits('')}}}/>
    <input type="hidden" name={name} value={digits?(cents/100).toFixed(2):''}/>
  </>
}
