# postmidia

SaaS multicliente de campanhas multicanal. O core controla o agendamento e a
publicação; Telegram e WhatsApp são nativos, e as demais redes publicam através
do Postiz.

O desenho completo, com as decisões e o que foi verificado em cada fase, está em
[ARCHITETURA.md](ARCHITETURA.md). Este README é o guia para rodar.

## Requisitos

- Node.js 18 ou superior
- Docker Desktop (para o Postgres, o Redis, o Postiz, o Temporal e o Elasticsearch)

## Subir o stack

```bash
docker compose up -d
```

Isso sobe cinco serviços: `postmidia-postgres`, `postmidia-redis`, `postiz`,
`temporal` e `postiz-elasticsearch`. **Um Postgres e um Redis só**, compartilhados
por todos — os databases separados resolvem o isolamento, não containers
separados.

| Serviço | Porta no host | Observação |
|---|---|---|
| PostgreSQL | 55432 | databases `postmidia`, `postiz`, `temporal` |
| Redis | 5638 | db0 Postmidia (fila e rate limit), db1 Postiz |
| Postiz | 4007 | a porta interna da imagem é 5000 (nginx) |
| Temporal | 7233 | |
| Elasticsearch | 9200 | obrigatório: o Temporal SQL aceita no máximo 3 search attributes |

> **Portas:** a porta pública **não** pode cair na faixa 49152–65535 nem em
> nenhuma "exclusão de porta" do Windows. O SO reserva essa faixa para conexões
> de saída e o proxy do Docker não consegue associá-la — o container sobe
> normalmente por dentro, mas de fora dá `ECONNREFUSED` sem mensagem útil.
> Antes de trocar, veja `netsh interface ipv4 show excludedportrange protocol=tcp`.

## Configurar a aplicação

```bash
cp .env.example .env
```

O `.env` guarda segredo e não é versionado. Dois campos precisam de valor real
antes de qualquer publicação:

```bash
# openssl rand -hex 32   (produção exige 32+ caracteres e recusa o valor de exemplo)
JWT_SECRET=
TOKEN_ENCRYPTION_KEY=

# Chave pública da conta local do Postiz: Settings > API Key.
# A API pública fica sob /api/public/v1 e o header Authorization leva a chave CRUA,
# sem "Bearer " — com o prefixo o Postiz responde 401.
POSTIZ_API_KEY=
```

Quem não define `REDIS_URL` não tem fila: em desenvolvimento a API sobe e nada
é agendado, e o motivo sai no log de boot.

### O portão de produção

Com `NODE_ENV=production` o boot valida o config e **sai com código 1**, em vez
de avisar. Config inválida que não trava o processo vira incidente: um
`JWT_SECRET` de exemplo significa que qualquer um forja token de admin, e uma
`REDIS_URL` vazia significa que a fila para de agendar sem ninguém perceber.

Bloqueiam o boot: `JWT_SECRET` fraco ou de exemplo, `TOKEN_ENCRYPTION_KEY`
nula, `DATABASE_URL` ou `REDIS_URL` ausentes, e `ALLOW_TENANT_HEADER=true` — o
header não é assinado e permitiria forjar o tenant.

Só avisam: `POSTIZ_API_KEY` vazia (os canais via Postiz falham na publicação) e
`ALLOW_SELF_SIGNUP=true` (cria tenants publicamente).

## Instalar e migrar

```bash
npm install
npm run migrate
```

A migration exige `DATABASE_MIGRATION_URL` (papel dono das tabelas) e é separada
de `DATABASE_URL` (papel da aplicação) de propósito: o papel da aplicação é
`NOSUPERUSER NOBYPASSRLS`, senão o RLS por tenant não valeria nada.

## Rodar

Em desenvolvimento, dois processos:

```bash
npm run dev          # API em http://localhost:8601
npm run dev:worker   # worker da fila, em processo separado
```

Em produção, build antes:

```bash
npm run build
npm start            # dist/server.js
npm run start:worker # dist/worker.js
```

O worker é separado de propósito. Com `EMBEDDED_WORKER=true` ele sobe junto com
a API, o que serve para desenvolvimento e mascara o principal risco do desenho:
reiniciar a API reinicia o consumidor da fila.

## Verificação

```bash
.\scripts\run-e2e.ps1                                  # 72 checks, sobe API e worker
npm run verify:provider-specs                          # 10 checks, sem Docker
npm run verify:dead-letter                             # 17 checks, exige DATABASE_URL
npm run verify:reconcile                               # 14 checks, exige DATABASE_URL
npm run verify:metrics                                 # 15 checks, exige DATABASE_URL
npm run verify:media                                   # 19 checks, sem Docker
npm run verify:queue                                   # fila fora do HTTP
npm run typecheck
```

O E2E usa **Git Bash**, não WSL: o WSL não alcança o loopback do Windows e a API
sobe em `127.0.0.1:8601`. Use `scripts/run-e2e.ps1` em vez de chamar
`verify-e2e.sh` direto — o runner resolve a perda de log e a limpeza dos
processos órfãos, e o motivo está documentado em
[ARCHITETURA.md](ARCHITETURA.md#como-rodar-a-verificacao).

## API

Todas as respostas usam `{ success, data }` ou `{ success, error }`. Todo
endpoint sob `/auth` autenticado exige `Authorization: Bearer <token>`.

| Método | Rota | Descrição |
|---|---|---|
| `GET` | `/health` | liveness; sempre 200 |
| `GET` | `/networks` | redes registradas, as bridged e os `NETWORK_SPECS` |
| `GET` | `/capabilities` | o que o build atual faz e não faz |
| `POST` | `/auth/signup` | cria tenant e usuário; exige `ALLOW_SELF_SIGNUP=true` |
| `POST` | `/auth/login` | devolve token; login é por `slug` + email |
| `GET` | `/auth/me` | usuário do token |
| `GET` | `/audit` | log de auditoria do tenant |
| `GET` `POST` | `/accounts` | listar e criar contas de rede |
| `PATCH` | `/accounts/:id/status` | ativar, expirar, revogar |
| `GET` | `/accounts/:id/settings` | specs do provedor; nas redes nativas, `native: true` |
| `POST` | `/accounts/:id/sync-specs` | re-lê os limites no provedor |
| `GET` `POST` | `/campaigns` | listar e criar campanhas |
| `POST` | `/campaigns/:id/posts` | agenda post; 422 se algum destino rejeitar |
| `GET` | `/jobs` | jobs com filtro por status e campanha |
| `GET` | `/dead-letters` | fila morta; `?resolution=open\|requeued\|discarded` e `?limit=` |
| `POST` | `/dead-letters/:id/resolve` | `{"action":"requeue"\|"discard"}`; exige `owner`/`admin` |
| `GET` | `/ops/metrics` | painel operacional; exige `x-metrics-token`, **não** JWT de tenant |
| `POST` | `/jobs/:id/reconcile` | força a busca do id do provedor; exige `owner`/`admin` |
| `GET` `POST` | `/whatsapp/templates` | templates; hoje o status é manual |
| `PATCH` | `/whatsapp/templates/:id/status` | muda o status do template |

A fila morta recebe o job que **esgotou as tentativas e ainda era retentável**.
Erro não retentável é terminal e não entra — nenhuma reexecução passaria.
`requeue` zera o orçamento de tentativas e devolve o job para a fila; `discard`
fecha a entrada sem republicar. Os dois devolvem `409` se a entrada já foi
tratada, ou se o job já `succeeded` no intervalo entre a leitura da triagem e o
clique.

Exemplo de ponta a ponta:

```bash
TOKEN=$(curl -s -X POST localhost:8601/auth/signup -H 'Content-Type: application/json' \
  -d '{"tenantName":"Acme","slug":"acme","email":"dev@acme.com","password":"trocar123456"}' \
  | jq -r .data.token)

curl -s -X POST localhost:8601/accounts -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"network":"whatsapp","externalAccountId":"1234","displayName":"WABA","secret":"tok"}'
```

### Painel operacional

```bash
curl -s "localhost:8601/ops/metrics?windowHours=24" -H "x-metrics-token: $METRICS_TOKEN"
curl -s "localhost:8601/ops/metrics?tenantId=<uuid>" -H "x-metrics-token: $METRICS_TOKEN"
```

Devolve volume e taxa de falha por rede, latência de publicação (p50/p95/máx),
estado atual da fila, pendências de reconciliação, DLQ em aberto e o consumo de
cota do Postiz com o alerta.

Duas coisas sobre esse número merecem atenção:

- **Latência vem de `published_at`, não de `updated_at`.** A reconciliação
  patcha o job horas depois de publicado; medir por `updated_at` mediria a
  lentidão da reconciliação, não da publicação. `verify:metrics` prova isso
  patchando o job de propósito e exigindo que a latência não mude.
- **`byStatus` não tem recorte de janela.** É o estoque atual da fila: um job
  travado há três dias continua sendo trabalho pendente hoje. O volume por rede,
  esse sim, é recortado pela janela.

O gate é um token de plataforma (`METRICS_TOKEN`), e o motivo está em
[ARCHITETURA.md](ARCHITETURA.md#o-painel-operacional-nao-pode-usar-o-jwt-de-tenant):
`owner`/`admin` são papéis **por tenant**, e todo tenant tem um `owner`, então
proteger a rota com eles mostraria a fila inteira para o dono de qualquer loja.
O RLS não salva essa rota, porque a leitura dela é de sistema. Sem token a rota
responde `503` — nunca liberada.

## Isolamento entre tenants

Cada requisição autenticada carrega um tenant, e o isolamento é imposto pelo
banco, não pela aplicação: RLS com `FORCE ROW LEVEL SECURITY` em 7 das 8
tabelas. O papel da aplicação é não-superuser e sem `BYPASSRLS`, então não dá
para contornar issuing SQL.

O slug identifica o tenant no login. `ALLOW_TENANT_HEADER=true` deixa aceitar o
tenant por header, sem assinatura — é o gancho para desenvolvimento de frontend
e o boot **recusa** o processo em produção por causa disso.

## Segurança

- Segredo de rede nunca em log e nunca em resposta: fica cifrado em repouso com
  AES-256-GCM, e a API devolve apenas a conta pública.
- Audit log é append-only: o papel da aplicação não tem `UPDATE` nem `DELETE`
  nessa tabela.
- Trocar `TOKEN_ENCRYPTION_KEY` depois invalida todos os segredos já cifrados.
- `POSTIZ_API_KEY` é a chave do painel local do Postiz, não um segredo de
  produção. Ela vai no `.env` e nunca no git.
- `METRICS_TOKEN` é o segredo do painel operacional: comparação em tempo
  constante, obrigatório em produção, e a rota falha fechada sem ele.
- A sonda de mídia rejeita endereços privados, loopback e link-local, e
  `MEDIA_PROBE_ALLOW_PRIVATE=true` é recusado no boot em produção.

## Estrutura

```
src/
  domain/      tipos e NETWORK_SPECS (limites derivados, nao autoritativos)
  channels/    adapter pattern; postiz/, telegram.adapter.ts, whatsapp.adapter.ts
  store/       porta de persistencia: postgres.store.ts e memory.store.ts
  queue/       porta de fila: redis.queue.ts (BullMQ) e memory.queue.ts
  db/          schema.sql e migrate.ts
  routes/      HTTP; core em Express, sem framework de DI
  security/    jwt, password, secret-box
scripts/       verificacao e scripts de stack
```

O core é **Express**, não Nest: o único Nest do projeto é o backend do Postiz,
que é de terceiros. A porta de persistência e a de fila têm duas implementações
cada, e o par Redis/Postgres é o caminho de verdade.

## Estado

Fases 0 a 7 implementadas e verificadas. Na 9, a **DLQ e a reconciliação de
`releaseIdMissing` estão prontas** (tabela, RLS, store, worker, rotas e testes);
faltam métricas e alerta de quota. A 6 e a 8 estão parciais por dependerem de
credenciais ou de decisões de produto, e a 10 depende de produto. O que falta e o
que está bloqueado está em
[ARCHITETURA.md](ARCHITETURA.md#7-etapas-do-projeto).
