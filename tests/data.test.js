import {test} from 'node:test';
import assert from 'node:assert/strict';
import {indicators,inDays,percent,csvCell} from '../src/data.js';
test('indicadores distinguem acidentes de incidentes, prazos e registros inativos',()=>{const rows=[{module:'colaboradores',status:'Ativo'},{module:'exames',due_date:'2026-12-01'},{module:'exames',due_date:'2026-11-01'},{module:'acidentes',event_date:'2026-11-17',details:{extra:'Acidente'}},{module:'acidentes',event_date:'2026-11-17',details:{extra:'Incidente'}},{module:'acidentes',event_date:'2026-09-01'},{module:'epis',status:'Concluído'},{module:'epis',status:'Pendente'},{module:'treinamentos',status:'Inativo'},{module:'licencas',due_date:'2027-01-01'}];assert.deepEqual(indicators(rows,30,'2026-11-18'),[1,1,1,1,0,1]);assert.equal(inDays('2026-11-17',30,'2026-11-18'),false)});
test('sem registros não implica 100% de conformidade',()=>{assert.equal(percent([]),null);assert.equal(percent([{status:'Concluído'},{status:'Pendente'}]),50)});
test('exportação neutraliza fórmulas e escapa aspas',()=>{assert.equal(csvCell('=1+2'),'"\'=1+2"');assert.equal(csvCell('A "B"'),'"A ""B"""')});
