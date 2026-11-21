import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
await fs.mkdir('test-results',{recursive:true});
const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
const context=await browser.newContext({viewport:{width:1600,height:1050}});
const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
let records=[];
const id='11111111-1111-4111-8111-111111111111';
const user={id,aud:'authenticated',role:'authenticated',email:'contatoalphagestor@gmail.com',app_metadata:{provider:'email'},user_metadata:{},created_at:new Date().toISOString()};
const token=Buffer.from('{}').toString('base64url')+'.'+Buffer.from(JSON.stringify({sub:id,exp:Math.floor(Date.now()/1000)+3600})).toString('base64url')+'.signature';
await page.route('https://fonts.googleapis.com/**',route=>route.abort());
await page.route('https://gotofoqjtjaeuicfqluo.supabase.co/**',async route=>{const req=route.request(),url=new URL(req.url()),body=req.postDataJSON();let data={},status=200;
 if(url.pathname.endsWith('/token')){if(body.password==='ui-test-password')data={access_token:token,refresh_token:'mock-refresh-token',expires_in:3600,token_type:'bearer',user};else{status=400;data={code:'invalid_credentials',msg:'Invalid login credentials'}}}
 else if(url.pathname.endsWith('/ssma_epi_workspace'))data={regions:[],materials:[],assignments:[],requests:[],movements:[],rules:[],assets:[]};
 else if(url.pathname.endsWith('/ssma_epi_dashboard'))data=[];
 else if(url.pathname.endsWith('/ssma_employee_technicians'))data=[{id:'55555555-5555-4555-8555-555555555555',name:'Técnico de teste'}];
 else if(url.pathname.endsWith('/ssma_profiles'))data={coverage:['DF','SP'],permissions:['colaboradores','residuos','epi.estoque','epi.anteriores'],user_id:id,username:'cesar',display_name:'César Nascimento'};
 else if(url.pathname.endsWith('/ssma_records')){if(req.method()==='POST'){const r={...body,id:'22222222-2222-4222-8222-222222222222',created_at:new Date().toISOString()};records.push(r);data=[{id:r.id}]}else if(req.method()==='PATCH'){records=records.map(r=>({...r,...body}));data=[{id:records[0].id}]}else if(req.method()==='DELETE'){data=records.map(r=>({id:r.id}));records=[]}else data=records;}
 else if(url.pathname.endsWith('/user'))data=user;
 await route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});
});
try{
await page.goto(process.env.APP_URL || 'http://127.0.0.1:5173');await page.getByRole('heading',{name:'Acesse sua conta'}).waitFor();assert.equal(await page.getByText('Criar conta',{exact:true}).count(),0);
await page.screenshot({path:'test-results/login-desktop.png',fullPage:true});
await page.locator('[name=username]').fill('cesar');await page.locator('[name=password]').fill('wrong');await page.getByRole('button',{name:'Entrar no sistema',exact:true}).click();await page.getByRole('alert').waitFor();
await page.locator('[name=password]').fill('ui-test-password');await page.getByRole('button',{name:'Entrar no sistema',exact:true}).click();await page.getByRole('heading',{name:'Dashboard Geral',exact:true}).waitFor();
await page.getByRole('button',{name:'Visualizar demonstração'}).click();await page.screenshot({path:'test-results/dashboard-desktop.png',fullPage:true});
await page.getByRole('button',{name:'Gestão de Resíduos',exact:true}).click();await page.getByRole('button',{name:'Novo registro',exact:true}).first().click();await page.locator('[name=title]').fill('Destinação de resíduos - teste');await page.locator('[name=person]').fill('Colaborador teste');await page.locator('[name=extra]').fill('CA 00000');await page.getByRole('button',{name:'Salvar registro'}).click();await page.getByRole('cell',{name:'Destinação de resíduos - teste'}).first().waitFor();
await page.getByRole('button',{name:'Editar Destinação de resíduos - teste'}).click();await page.locator('[name=status]').selectOption('Concluído');await page.getByRole('button',{name:'Salvar registro'}).click();await page.getByRole('cell',{name:'Concluído',exact:true}).waitFor();assert.equal(records[0].status,'Concluído');
await page.getByRole('button',{name:'Excluir Destinação de resíduos - teste'}).click();await page.getByRole('button',{name:'Excluir registro',exact:true}).click();await page.getByRole('heading',{name:'Comece por um novo registro'}).waitFor();assert.equal(records.length,0);
await page.getByRole('button',{name:'Dashboard Geral',exact:true}).click();await page.getByLabel('Buscar no sistema').fill('resíduos');await page.getByRole('heading',{name:'Resultados da busca'}).waitFor();await page.getByRole('button',{name:'Gestão de Resíduos',exact:true}).last().click();await page.getByRole('heading',{name:'Gestão de Resíduos',exact:true}).waitFor();
await page.getByRole('button',{name:'Colaboradores',exact:true}).click()
await page.getByRole('button',{name:'Novo colaborador',exact:true}).first().click()
const employeeDialog=page.getByRole('dialog')
await employeeDialog.getByLabel('Colaborador',{exact:true}).fill('Funcionária de teste')
await employeeDialog.getByLabel('Data de admissão').fill('2026-09-01')
for(const [label,value] of Object.entries({'Cargo':'Eletricista','Matrícula':'00045','CPF':'00000000000','E-mail':'teste@example.com','Empresa':'Empresa de teste','Setor':'Operações','CNPJ':'00.000.000/0000-00','Coordenador':'Coordenação A','Gerência':'Gerência A','Projeto':'Projeto A'})){
  await employeeDialog.getByLabel(label,{exact:true}).fill(value)
}
await employeeDialog.getByRole('combobox',{name:'Técnico de segurança responsável'}).selectOption({label:'Técnico de teste'})
await employeeDialog.getByLabel('UF',{exact:true}).selectOption('DF')
assert.equal(await employeeDialog.getByLabel('Região',{exact:true}).inputValue(),'Centro-Oeste')
for(const label of ['NR 06','NR 10 Básica','SEP','NR 12','NR 18','NR 20']){
  await employeeDialog.getByLabel('Status · '+label,{exact:true}).selectOption('Ativo')
  await employeeDialog.getByLabel('Data da última certificação · '+label,{exact:true}).fill('2026-09-02')
  await employeeDialog.getByLabel('Observações · '+label,{exact:true}).fill('Observação '+label)
}
await employeeDialog.getByRole('button',{name:'Salvar registro'}).click()
await page.getByRole('button',{name:'Editar Funcionária de teste'}).click()
assert.equal(await employeeDialog.getByLabel('Matrícula').inputValue(),'00045')
assert.equal(await employeeDialog.getByLabel('Setor',{exact:true}).inputValue(),'Operações')
assert.equal(await employeeDialog.getByLabel('CNPJ',{exact:true}).inputValue(),'00.000.000/0000-00')
assert.equal(await employeeDialog.getByLabel('CPF').inputValue(),'000.000.000-00')
assert.equal(await employeeDialog.getByLabel('Observações · NR 20').inputValue(),'Observação NR 20')
await employeeDialog.getByLabel('Desligado').check()
await employeeDialog.getByLabel('Status · SEP',{exact:true}).selectOption('Suspenso')
await employeeDialog.getByRole('button',{name:'Salvar registro'}).click()
await page.getByRole('cell',{name:'Desligado',exact:true}).waitFor()
await page.getByRole('cell',{name:'Técnico de teste',exact:true}).waitFor()
assert.equal(records[0].details.technicianId,'55555555-5555-4555-8555-555555555555')
assert.equal(records[0].details.certifications.sep.status,'Suspenso')
assert.equal(records[0].details.admission,'2026-09-01')
const original = records[0]
records.push(
  { ...original, id:'33333333-3333-4333-8333-333333333333', title:'Ágata de teste', unit:'Projeto B / SP', employee_state:null, status:'Ativo', person:'Responsável anterior', details:{coordinator:'Coordenação B',management:'Gerência B'} },
  { ...original, id:'44444444-4444-4444-8444-444444444444', title:'Zilda de teste', status:'Ativo', details:{...original.details,management:'Gerência B'} }
)
await page.reload()
await page.getByRole('button',{name:'Colaboradores',exact:true}).click()
const filterPanel = page.getByRole('group',{name:'Filtros de colaboradores'})
const filter = name => filterPanel.getByLabel(name,{exact:true})
const names = () => page.locator('.records tbody tr td:first-child strong').allTextContents()
await filterPanel.waitFor()
await page.getByRole('columnheader',{name:'Técnico responsável',exact:true}).waitFor()
await page.getByRole('button',{name:'Editar Ágata de teste'}).click()
const responsible = employeeDialog.getByRole('combobox',{name:'Técnico de segurança responsável'})
await responsible.getByRole('option',{name:'Técnico de teste',exact:true}).waitFor({state:'attached'})
assert.match(await responsible.locator('option:checked').textContent(),/Responsável anterior/)
await employeeDialog.getByRole('button',{name:'Cancelar'}).click()
assert.deepEqual(await names(),['Ágata de teste','Funcionária de teste','Zilda de teste'])
await filter('Ordem alfabética').selectOption('desc')
assert.deepEqual(await names(),['Zilda de teste','Funcionária de teste','Ágata de teste'])
await filter('Projeto').selectOption({label:'Projeto A'})
await filter('Coordenador').selectOption({label:'Coordenação A'})
await filter('Região').selectOption({label:'Centro-Oeste'})
assert.equal(await filter('Estado').getByRole('option',{name:'SP',exact:true}).count(),0)
await filter('Estado').selectOption({label:'DF'})
await filter('Gerente').selectOption({label:'Gerência B'})
assert.deepEqual(await names(),['Zilda de teste'])
await page.getByLabel('Buscar no sistema').fill('agata')
await page.getByRole('heading',{name:'Nenhum resultado para esses filtros'}).waitFor()
assert.equal(await page.getByRole('button',{name:'Exportar'}).isDisabled(),true)
await filterPanel.getByRole('button',{name:'Limpar filtros da lista'}).click()
assert.deepEqual(await names(),['Ágata de teste'])
await page.getByRole('button',{name:'Limpar busca'}).click()
await filter('Região').selectOption({label:'Sudeste'})
await filter('Estado').selectOption({label:'SP'})
assert.deepEqual(await names(),['Ágata de teste'])
await filter('Região').selectOption({label:'Centro-Oeste'})
assert.equal(await filter('Estado').inputValue(),'')
await page.setViewportSize({width:390,height:844})
assert.ok(await filterPanel.evaluate(el=>el.getBoundingClientRect().right<=window.innerWidth))
await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'Abrir menu'}).click();await page.getByRole('button',{name:'Dashboard Geral',exact:true}).click();await page.getByRole('button',{name:'Visualizar demonstração'}).click();await page.screenshot({path:'test-results/dashboard-mobile.png',fullPage:true});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),'No mobile overflow');
await page.getByRole('button',{name:'Abrir menu'}).click();await page.getByRole('button',{name:'Sair do sistema'}).click();await page.getByRole('heading',{name:'Acesse sua conta'}).waitFor();await page.screenshot({path:'test-results/login-mobile.png',fullPage:true});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));assert.deepEqual(errors,[]);console.log('PASS: login, invalid password, navigation, CRUD, search, demo, mobile, logout. HTTP calls mocked; backend verified separately.');
}finally{await browser.close()}
