import React, {useState} from 'react'

export function usePages(items, filter) {
  const [choice,setChoice]=useState({filter,page:1})
  const count=Math.max(1,Math.ceil(items.length/25))
  const page=choice.filter===filter ? Math.min(choice.page,count) : 1
  const numbers=Array.from({length:count},(_,i)=>i+1).filter(n=>n===1||n===count||Math.abs(n-page)<=2)
  const controls=count>1 && <nav className="page-numbers" aria-label="Paginação">
    {numbers.map((n,i)=><React.Fragment key={n}>{i>0&&n>numbers[i-1]+1&&<span>…</span>}
      <button type="button" className={page===n?'primary':'secondary'} aria-current={page===n?'page':undefined}
        aria-label={'Página '+n} onClick={()=>setChoice({filter,page:n})}>{n}</button></React.Fragment>)}
  </nav>
  return {items:items.slice((page-1)*25,page*25),controls}
}
