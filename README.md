# Sistema SSMA 2.0

Aplicação React/Vite em português, com identidade vermelha, branca e preta baseada no layout aprovado. Autenticação real pelo Supabase, sem cadastro público na interface.

## Executar

Node.js 22.12+ ou 24. Instale com `npm ci` e execute `npm run dev`. Para produção, `npm run build` gera `dist/`. `vercel.json` já configura publicação, roteamento e cabeçalhos.

As variáveis públicas estão em `.env.example`. Nenhuma senha de usuário ou chave administrativa está incluída no código. O usuário inicial `cesar` foi provisionado no Supabase e usa a senha fornecida pelo proprietário durante a configuração. A alteração de senha está no menu Administração.

## Funcionalidades

- Login, persistência da sessão, logout e alteração de senha com confirmação da senha atual.
- Dashboard calculado a partir dos registros, filtro por unidade e período para o total de acidentes.
- Demonstração visual claramente identificada, sem inserir dados fictícios no banco.
- Quatro categorias de módulos e cadastro de colaboradores.
- Cadastro, leitura, edição, exclusão confirmada, pesquisa, filtro de status e exportação CSV.
- Campos específicos para cada módulo, prazos, responsáveis, unidades e observações.
- Layout responsivo para computador e celular.

## Banco e acesso

Projeto Supabase: `gotofoqjtjaeuicfqluo`, organização Sistema SSMA, região São Paulo.

`database/schema.sql` documenta as tabelas e políticas aplicadas. `ssma_profiles` permite leitura apenas do próprio perfil. `ssma_records` usa RLS por proprietário e exige um perfil previamente autorizado. O navegador utiliza somente chave publicável. Novos perfis devem ser criados por administração confiável; não há cadastro na interface.

O módulo de prontuário organiza registros; não inclui certificação de prontuário eletrônico, assinatura digital ou controle multiusuário por papel clínico. O eSocial controla eventos e protocolos; transmissão oficial ainda não foi implementada. PGR, PCMSO, PT/APR e AET têm gestão de registros, sem geração automática dos documentos técnicos.

As porcentagens do painel representam a proporção de registros concluídos/ativos e não certificam conformidade normativa. Sem registros, o percentual aparece como traço. Dados sensíveis permanecem restritos ao proprietário autenticado.

## Gestão de EPIs

Em **Gestão de EPIs → Regionais e vínculos**, associe a regional ao login de um técnico autorizado e vincule cada colaborador ativo ao estado, projeto e cargo. O vínculo pode incluir centro de custo e contrato. Em `/emissaoepi`, o colaborador escolhe nome e estado sem login. O pedido gera um código de rastreio para consultar o andamento e o número dos Correios informado pelo técnico em **Solicitações**.

No estoque, cada registro representa uma variante de tamanho e cor em uma regional e, opcionalmente, em um centro de custo. O colaborador vê o estoque compartilhado da regional e o do seu centro de custo. O nome e o CA são obrigatórios, salvo quando a opção **Material sem CA** é marcada. O saldo inicial e as reposições geram entradas. O custo unitário segue a média ponderada do saldo físico e das novas entradas, arredondada a centavos. Um material sem regional pode ser vinculado posteriormente.

Pedidos reservam saldo disponível. O técnico responsável confirma a entrega em **Solicitações** e escolhe projeto ou SSMA. A entrega gera a saída, a despesa e a ficha individual imprimível. O cancelamento libera a reserva. **Ensaios e retornos** acompanha equipamentos entregues por série, com laboratório, laudo, movimentações e próxima data de ensaio. Em **Previsão de compras**, configure o intervalo de troca e a quantidade por cargo e variante. Registros de EPI anteriores continuam acessíveis na aba correspondente.

O esquema inicial está em `database/schema.sql` e as migrações de EPI em `supabase/migrations/`. Em uma nova instalação, aplique o esquema inicial e depois as migrações em ordem de versão.

## Validação

`npm test` verifica cálculos e proteção contra fórmulas em CSV. `node tests/browser.mjs` verifica a interface com HTTP simulado: login inválido/válido, CRUD, busca, demonstração, logout e ausência de transbordamento no celular. O teste usa Chrome instalado no Windows; ajuste o caminho para outro ambiente.

Os testes de EPI em `npm test` executam a migração em PostgreSQL local via PGlite. Com o Vite em execução, `node tests/epi-browser.mjs` percorre o portal, a entrega, o financeiro, a ficha e o ensaio no Chrome usando o mesmo banco isolado.

Autenticação real e acesso pela REST API foram verificados separadamente no Supabase: login e leitura autenticada 200, criação 201, exclusão 204 e acesso anônimo 401. O registro de teste foi removido. Auditoria de tabelas não apresentou falta de RLS. A proteção de senha vazada do Supabase está desativada; veja https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection.

## Integrações

Sistema publicado em https://sistema-ssma-2.vercel.app. Projeto Vercel `prj_B9EAK0sqHY9MGvGhY416iISDAaZO`, equipe `team_lBuKO6hVlkrugW1xRe1eE8N1`. Publicação inicial `dpl_FtUXZS3mbrPLkW1efPmKRmnQe4Uh`, validada como READY e HTTP 200.

Conta solicitada: contatoalphagestor@gmail.com. Repositório oficial: https://github.com/alphagestor2027/sistemassma, branch principal `main`. Os arquivos da aplicação ficam na raiz do repositório. O banco permanece no projeto Supabase indicado acima.
