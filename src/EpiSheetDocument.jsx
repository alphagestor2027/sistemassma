import React from 'react'
import { dateLabel } from './data'
import './epi-sheet.css'

export const defaultLegal = `Consolidação das Leis do Trabalho – CLT, Capítulo V, Título II, Seção IV – Do Equipamento de Proteção Individual. Lei nº 6.514/1977, Portaria MTb nº 3.214/1978 e Norma Regulamentadora nº 6.

NR-1 — Disposições gerais e gerenciamento de riscos ocupacionais
1.4.2 Cabe ao trabalhador:
a) cumprir as disposições legais e regulamentares sobre segurança e saúde no trabalho, inclusive as ordens de serviço expedidas pelo empregador;
b) submeter-se aos exames médicos previstos nas NR;
c) colaborar com a organização na aplicação das NR;
d) usar o equipamento de proteção individual fornecido pelo empregador.
1.4.2.1 Constitui ato faltoso a recusa injustificada do empregado ao cumprimento do disposto nas alíneas do subitem anterior.

NR-6 — Equipamento de proteção individual
6.6.1 O trabalhador deve usar o EPI fornecido pela organização, conforme a seleção para a atividade e a finalidade prevista. Deve cuidar da limpeza, guarda e conservação, comunicar extravio, dano ou alteração que torne o equipamento impróprio e seguir as orientações da organização para o uso adequado.

CLT, art. 462, § 1º
Em caso de dano causado pelo empregado, o desconto depende de acordo prévio que preveja essa possibilidade ou de dolo do empregado.`
export const defaultTerm = `Declaro estar ciente da legislação acima e que recebi orientação específica sobre a necessidade e os métodos adequados de utilização e conservação dos Equipamentos de Proteção Individual – EPI, bem como dos riscos de minhas atividades e das consequências do desenvolvimento dessas atividades sem o uso dos EPI’s.

Ao receber os EPI’s descritos acima, me responsabilizarei pelos mesmos, me comprometendo em devolvê-los quando não estiverem em condições de uso ou por ocasião de transferência ou afastamento da empresa, bem como o reembolso em caso de extravio ou danificação por uso indevido.`

export const identityFields = [
  ['company','Empresa'], ['ie','Inscrição estadual'], ['cnpj','CNPJ da empresa'],
  ['unit','Unidade / projeto'], ['unitCnpj','CNPJ da unidade'],
  ['name','Colaborador'], ['cpf','CPF'], ['registration','Matrícula'], ['sector','Setor'], ['job','Função'],
]

export function defaultSettings(snapshot, template) {
  const identity = Object.fromEntries(identityFields.map(([key]) => [key,snapshot[key] || '']))
  return { legal:defaultLegal, term:defaultTerm, logo:'', ...template, identity, place:'', reasons:{} }
}

function Masthead({logo,number}) {
  return <header className="fepi-mast">
    {logo && <img alt="Logo da empresa" src={logo}/>}
    <div><b>Ficha de controle de entrega de equipamentos de proteção individual</b><span>EPI</span></div>
    <strong>{number ? 'Nº ' + number : 'Prévia'}</strong>
  </header>
}

export function SheetDocument({snapshot,settings,number,issuedAt}) {
  const {identity} = settings
  const header = <Masthead logo={settings.logo} number={number}/>
  return <article className="epi-print fepi-document" aria-label="Ficha de EPI para impressão">
    <section className="fepi-page">
      {header}
      <div className="fepi-identity">{identityFields.map(([key,label]) =>
        <div key={key}><span>{label}</span><strong>{identity[key] || '—'}</strong></div>
      )}<div><span>Emissão</span><strong>{issuedAt ? new Date(issuedAt).toLocaleDateString('pt-BR',{timeZone:'America/Sao_Paulo'}) : '—'}</strong></div></div>
      <h3>Fundamentação legal</h3><div className="fepi-text">{settings.legal}</div>
      <h3>Controle de fornecimento de EPI</h3>
      <table><thead><tr>{['Data','CA','Equipamento','Qtd.','Motivo'].map(label => <th key={label}>{label}</th>)}</tr></thead>
        <tbody>{snapshot.items.map(line => <tr key={line.key}><td>{dateLabel(line.date)}</td><td>{line.ca || 'Sem CA'}</td>
          <td>{line.equipment}</td><td>{line.qty}</td><td>{settings.reasons[line.key] || '—'}</td></tr>)}
          {!snapshot.items.length && <tr><td colSpan={5}>Nenhuma entrega confirmada.</td></tr>}</tbody>
      </table>
    </section>
    <section className="fepi-page">
      {header}
      <h3>Termo de responsabilidade</h3><div className="fepi-text">{settings.term}</div>
      <p className="fepi-place">{settings.place || '________________________'}, ______ de __________________ de __________.</p>
      <div className="fepi-sign"><strong>{identity.name}</strong><span>Assinatura do colaborador</span></div>
    </section>
  </article>
}
