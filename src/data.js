export const today = () => new Date().toLocaleDateString('en-CA',{timeZone:'America/Sao_Paulo'});
export const isDone = r => ['Concluído','Ativo'].includes(r.status);
export const dateLabel = d => d ? new Date(d+'T12:00:00').toLocaleDateString('pt-BR') : '—';
export function inDays(date,days,now=today()) { if(!date)return false; const delta=(Date.parse(date+'T12:00:00')-Date.parse(now+'T12:00:00'))/86400000; return delta>=0 && delta<=days; }
export function indicators(rows,days=30,now=today(),period=null) {
 const from=new Date(now+'T12:00:00');from.setDate(from.getDate()-days);
 return [rows.filter(r=>r.module==='colaboradores'&&r.status==='Ativo').length,rows.filter(r=>r.module==='exames'&&inDays(r.due_date,30,now)).length,rows.filter(r=>r.module==='acidentes'&&r.details?.extra!=='Incidente'&&(period ? r.event_date>=period.start&&r.event_date<=period.end : Date.parse(r.event_date+'T12:00:00')>=from.getTime()&&r.event_date<=now)).length,rows.filter(r=>r.module==='epis'&&!isDone(r)&&r.status!=='Inativo').length,rows.filter(r=>r.module==='treinamentos'&&!isDone(r)&&r.status!=='Inativo').length,rows.filter(r=>r.module==='licencas'&&inDays(r.due_date,60,now)).length];
}
export function percent(rows) { const active=rows.filter(r=>r.status!=='Inativo'); return active.length ? Math.round(active.filter(isDone).length/active.length*100) : null; }
export function csvCell(v) { const s=String(v??'');return '"'+(/^[=+@\-\t\r]/.test(s)?"'":'')+s.replaceAll('"','""')+'"'; }
export function exportCsv(rows) { const lines=[['Módulo','Descrição','Colaborador / responsável','Unidade','Status','Data','Vencimento','Detalhe','Observações'],...rows.map(r=>[r.module,r.title,r.person,r.unit,r.status,r.event_date,r.due_date,r.details?.extra,r.notes])]; const blob=new Blob(['\uFEFF'+lines.map(r=>r.map(csvCell).join(';')).join('\r\n')],{type:'text/csv;charset=utf-8'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='ssma-registros.csv';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000); }
