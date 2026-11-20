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
 else if(url.pathname.endsWith('/ssma_profiles'))data={user_id:id,username:'cesar',display_name:'César Nascimento'};
 else if(url.pathname.endsWith('/ssma_records')){if(req.method()==='POST'){const r={...body,id:'22222222-2222-4222-8222-222222222222',created_at:new Date().toISOString()};records.push(r);data=[{id:r.id}]}else if(req.method()==='PATCH'){records=records.map(r=>({...r,...body}));data=[{id:records[0].id}]}else if(req.method()==='DELETE'){data=records.map(r=>({id:r.id}));records=[]}else data=records;}
 else if(url.pathname.endsWith('/user'))data=user;
 await route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});
});
try{
await page.goto('http://127.0.0.1:5173');await page.getByRole('heading',{name:'Acesse sua conta'}).waitFor();assert.equal(await page.getByText('Criar conta',{exact:true}).count(),0);
await page.screenshot({path:'test-results/login-desktop.png',fullPage:true});
await page.locator('[name=username]').fill('cesar');await page.locator('[name=password]').fill('wrong');await page.getByRole('button',{name:'Entrar no sistema',exact:true}).click();await page.getByRole('alert').waitFor();
await page.locator('[name=password]').fill('ui-test-password');await page.getByRole('button',{name:'Entrar no sistema',exact:true}).click();await page.getByRole('heading',{name:'Dashboard Geral',exact:true}).waitFor();
await page.getByRole('button',{name:'Visualizar demonstração'}).click();await page.screenshot({path:'test-results/dashboard-desktop.png',fullPage:true});
await page.getByRole('button',{name:'Gestão de EPIs',exact:true}).click();await page.getByRole('button',{name:'Registros anteriores',exact:true}).click();await page.getByRole('button',{name:'Novo registro',exact:true}).first().click();await page.locator('[name=title]').fill('Capacete de segurança - teste');await page.locator('[name=person]').fill('Colaborador teste');await page.locator('[name=extra]').fill('CA 00000');await page.getByRole('button',{name:'Salvar registro'}).click();await page.getByRole('cell',{name:'Capacete de segurança - teste'}).first().waitFor();
await page.getByRole('button',{name:'Editar Capacete de segurança - teste'}).click();await page.locator('[name=status]').selectOption('Concluído');await page.getByRole('button',{name:'Salvar registro'}).click();await page.getByRole('cell',{name:'Concluído',exact:true}).waitFor();assert.equal(records[0].status,'Concluído');
await page.getByRole('button',{name:'Excluir Capacete de segurança - teste'}).click();await page.getByRole('button',{name:'Excluir registro',exact:true}).click();await page.getByRole('heading',{name:'Comece por um novo registro'}).waitFor();assert.equal(records.length,0);
await page.getByRole('button',{name:'Dashboard Geral',exact:true}).click();await page.getByLabel('Buscar no sistema').fill('resíduos');await page.getByRole('heading',{name:'Resultados da busca'}).waitFor();await page.getByRole('button',{name:'Gestão de Resíduos',exact:true}).last().click();await page.getByRole('heading',{name:'Gestão de Resíduos',exact:true}).waitFor();
await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'Abrir menu'}).click();await page.getByRole('button',{name:'Dashboard Geral',exact:true}).click();await page.getByRole('button',{name:'Visualizar demonstração'}).click();await page.screenshot({path:'test-results/dashboard-mobile.png',fullPage:true});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),'No mobile overflow');
await page.getByRole('button',{name:'Abrir menu'}).click();await page.getByRole('button',{name:'Sair do sistema'}).click();await page.getByRole('heading',{name:'Acesse sua conta'}).waitFor();await page.screenshot({path:'test-results/login-mobile.png',fullPage:true});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));assert.deepEqual(errors,[]);console.log('PASS: login, invalid password, navigation, CRUD, search, demo, mobile, logout. HTTP calls mocked; backend verified separately.');
}finally{await browser.close()}
