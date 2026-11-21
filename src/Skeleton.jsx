import React, {useSyncExternalStore} from 'react'

export function Skeleton({layout='table', label='Carregando conteúdo…'}) {
  return <div className={'loading-skeleton skeleton-'+layout} role="status" aria-label={label}>
    <div aria-hidden="true" className="skeleton-surface">
      <span className="skeleton-block skeleton-title"/>
      {layout==='dashboard' && <div className="skeleton-cards">
        {[0,1,2,3].map(i=><div className="skeleton-card" key={i}><i className="skeleton-block"/><b className="skeleton-block"/></div>)}
      </div>}
      <div className="skeleton-rows">
        {Array.from({length:layout==='compact'?1:3},(_,i)=><div className="skeleton-row" key={i}>
          <span className="skeleton-block"/><span className="skeleton-block"/><span className="skeleton-block"/>
        </div>)}
      </div>
    </div>
  </div>
}

let pending=0, visible=false, timer
const listeners=new Set()
function setVisible(value) {
  if (visible===value) return
  visible=value
  for (const listener of listeners) listener()
}
function subscribe(listener) {
  listeners.add(listener)
  return ()=>listeners.delete(listener)
}
export async function loadingFetch(...args) {
  if (++pending===1) timer=setTimeout(()=>setVisible(true),180)
  try {
    return await fetch(...args)
  } finally {
    if (--pending===0) {
      clearTimeout(timer)
      setVisible(false)
    }
  }
}
export function RequestSkeleton() {
  const active=useSyncExternalStore(subscribe,()=>visible)
  return active && <div className="skeleton-activity skeleton-block" role="progressbar" aria-label="Carregando dados"/>
}
