# Autowhats

Atendente virtual de WhatsApp com IA para varejo. A **Isis** responde clientes consultando o catálogo da loja em tempo real: estoque por tamanho, preços, sugestões quando algo está esgotado e fechamento de pedido com entrega ou retirada.

Esta versão roda em um **simulador de WhatsApp Web**. A ligação com o WhatsApp de verdade (API oficial da Meta) é uma etapa futura.

## O que tem aqui

| Parte | Arquivo | O que faz |
|---|---|---|
| Simulador de WhatsApp Web | `src/components/WhatsAppSimulator.tsx` | Réplica do WhatsApp Web: balões, avatar, "digitando...", checks cinza e azul, formatação `*negrito*`. Botões com as perguntas de teste. |
| Gerenciador de catálogo | `src/components/CatalogManager.tsx` | Adicionar, editar, remover e pausar produtos. SKU, preço, descrição, categoria e grade de tamanhos com estoque. Importação por CSV ou direto do Postgres do cliente. |
| Painel da Isis e métricas | `src/components/DashboardMetrics.tsx` | Nome da atendente, tom de voz, loja, endereço, horário, taxa de entrega e saudação. Mensagens processadas, checagens de falta de estoque, pedidos simulados e faturamento. |
| Motor de IA | `server.ts` + `server/ai.ts` | A cada mensagem, lê o catálogo e as configurações do Postgres e monta o prompt de sistema. Usa o Claude (Anthropic) com duas ferramentas: registrar falta de estoque e registrar pedido. |
| Banco de dados | `server/db.ts` | Postgres. As tabelas são criadas sozinhas na primeira execução, e um catálogo de exemplo é carregado se estiver vazio. |

### Como a sincronização em tempo real funciona
O servidor não guarda o catálogo em memória. Toda mensagem do cliente busca os produtos ativos no Postgres e injeta a lista no prompt da IA. Por isso, se você criar o "Boné Strapback" ou zerar o tamanho G da camiseta, a resposta seguinte já leva isso em conta.

### Pedidos
Quando o cliente confirma, a IA chama `registrar_pedido`. O **servidor** confere o estoque, calcula o total oficial (com taxa de entrega, se houver), baixa o estoque e devolve o número do pedido. A IA nunca decide o preço sozinha.

## Rodar no seu computador

Requisitos: **Node.js 20+** e **PostgreSQL 14+** (ou só o Docker).

```bash
# 1. Banco de dados
psql -U postgres -c "CREATE USER autowhats WITH PASSWORD 'autowhats';"
psql -U postgres -c "CREATE DATABASE autowhats OWNER autowhats;"

# 2. Configuração
cp .env.example .env
#   edite o .env: ANTHROPIC_API_KEY e DATABASE_URL

# 3. Instalar e rodar
npm install
npm run dev
```

Abra http://localhost:5173. A API roda na porta 3001.

Teste o roteiro:
1. "Olá, vocês têm a Camiseta Classic no tamanho M? Quanto custa?" → sim, R$ 89,90.
2. "E no tamanho G, tem?" → esgotado, com sugestão de outro tamanho ou item.
3. "Gostaria de fechar o pedido do tênis Air Sport" → lista os tamanhos, calcula o total e pergunta entrega ou retirada na Av. Paulista.
4. Em **Estoque & Catálogo**, crie "Boné Strapback", R$ 59,90, tamanho Único com 10 unidades. Volte ao chat: "Vocês vendem boné?"

## Variáveis do `.env`

| Variável | Para que serve |
|---|---|
| `ANTHROPIC_API_KEY` | Chave da API da Anthropic (console.anthropic.com). |
| `DATABASE_URL` | Conexão com o Postgres do Autowhats. |
| `PORT` | Porta do servidor (padrão 3001). |
| `APP_PASSWORD` | Senha do painel (usuário `admin`). **Obrigatória em produção**, senão qualquer pessoa pode mexer no catálogo e gastar créditos da API. |
| `AI_MODEL` | Opcional. Padrão `claude-opus-5-5`. |
| `AI_EFFORT` | Opcional. `low` (padrão, mais rápido), `medium` ou `high`. |

## Importar o catálogo do cliente

**CSV:** uma linha por tamanho, colunas `sku, nome, descricao, categoria, preco, tamanho, estoque`. Aceita vírgula ou ponto e vírgula, preço como `89,90` ou `R$ 1.299,90`, e também uma coluna `tamanhos` no formato `P:5;M:3;G:0`. Produtos com SKU já existente são atualizados. Exemplo em `exemplos/catalogo-exemplo.csv`.

**Postgres do cliente:** informe a conexão e um `SELECT` que devolva as mesmas colunas do CSV, renomeando com `AS`. A consulta roda em transação somente leitura, com limite de 15 segundos. Exemplo:

```sql
SELECT p.codigo AS sku, p.nome, p.descricao, p.categoria,
       p.preco_venda AS preco, e.tamanho, e.quantidade AS estoque
FROM produtos p JOIN estoque e ON e.produto_id = p.id
WHERE p.ativo
```

## Publicar em autowhats.automacaonow.com.br (VPS com EasyPanel)

O projeto tem um `Dockerfile`, então o EasyPanel constrói e roda tudo sozinho, com HTTPS automático.

### 1. Subdomínio
Onde o DNS de `automacaonow.com.br` é gerenciado (cPanel da HostGator → Zone Editor, ou Registro.br), crie um registro **A** com nome `autowhats` apontando para o IP do VPS.

### 2. Banco de dados
No EasyPanel, crie um projeto chamado `autowhats` e, dentro dele, **+ Service → Postgres** com o nome `db`. Na aba de credenciais, copie a **URL de conexão interna** (algo como `postgres://postgres:SENHA@autowhats_db:5432/autowhats`).

### 3. Aplicação
No mesmo projeto, **+ Service → App** com o nome `app`.
- **Source:** GitHub (recomendado, se o código estiver num repositório) ou **Upload** do arquivo `autowhats-easypanel.zip`.
- **Build:** escolha **Dockerfile** (caminho `Dockerfile`).
- **Environment:**
  ```
  ANTHROPIC_API_KEY=sk-ant-...
  DATABASE_URL=<URL interna copiada no passo 2>
  APP_PASSWORD=<uma senha forte>
  ```
- **Domains:** adicione `autowhats.automacaonow.com.br`, com HTTPS ligado e **porta 3001**.

Clique em **Deploy**. Na primeira execução as tabelas são criadas e o catálogo de exemplo é carregado.

Teste: abra https://autowhats.automacaonow.com.br, entre com usuário `admin` e a senha do `APP_PASSWORD`. O endereço `/api/health` deve responder `{"ok":true}`.

### Atualizar depois
Com GitHub, cada push pode fazer o deploy automático (ative em Deployments). Com upload, envie o novo zip e clique em Deploy.

## Comandos

| Comando | O que faz |
|---|---|
| `npm run dev` | Desenvolvimento (API + frontend com recarga automática). |
| `npm run build` | Gera o frontend em `dist/`. |
| `npm start` | Produção: a API serve também o frontend. |
| `npm run typecheck` | Verifica os tipos do TypeScript. |
| `npm run db:seed` | Cria as tabelas e carrega o catálogo de exemplo, se estiver vazio. |

## Próximos passos sugeridos
- Ligar no WhatsApp real pela API oficial da Meta (WhatsApp Cloud API), reaproveitando o mesmo motor de IA.
- Login por usuário e vários lojistas no mesmo servidor.
- Sincronização agendada com o banco do cliente, em vez de importação manual.
