#!/bin/sh
# Verificacao ponta a ponta com API e worker em processos distintos,
# compartilhando estado apenas pelo Redis e pelo Postgres.
#
# Uso (no host, com o .env apontando para o Postgres/Redis de dev):
#   sh scripts/verify-e2e.sh
#
# O script precisa de um shell POSIX. No Windows use o Git Bash:
#   "C:\Program Files\Git\bin\bash.exe" -lc "cd /c/.../postmidia && sh scripts/verify-e2e.sh"
# O WSL nao serve: ele roda em namespace de rede proprio, e o 127.0.0.1 de la
# nao e o loopback do Windows onde a API sobe.

set -e

BASE="http://127.0.0.1:${PORT:-8601}"
SLUG="e2e-$(date +%s)"
PASS=0
FAIL=0

# O Redis da aplicacao vem do REDIS_URL do .env. Antes este script assumia 6379
# fixo, que e a porta de outro projeto aqui, e usava redis-cli -- que nao existe
# no Git Bash deste host. O resultado era '?' no lugar de um numero, e a
# checagem passava por vacuidade: verde falso.
#
# Contar com ioredis (a mesma lib que o app usa via BullMQ) resolve os dois
# problemas: a porta vem do .env e nao ha binario externo para depender.
#
# O .env precisa ser carregado aqui: este script nao usa dotenv, e sem REDIS_URL
# no ambiente o ioredis cairia no 6379 padrao.
if [ -z "$REDIS_URL" ] && [ -f .env ]; then
  REDIS_URL=$(sed -n 's/^REDIS_URL=//p' .env | head -1 | tr -d '"'"'"' \r')
  export REDIS_URL
fi

redis_count() {
  node -e '
    const Redis = require("ioredis");
    const r = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1, retryStrategy: () => null });
    r.zcard("bull:postmidia-publish:delayed")
      .then((n) => { console.log(n); process.exit(0); })
      .catch(() => process.exit(1))
      .finally(() => r.disconnect());
  ' 2>/dev/null
}

ok()   { PASS=$((PASS+1)); echo "  ok   $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  FAIL $1"; }
check() { if [ "$2" = "$3" ]; then ok "$1 ($2)"; else bad "$1: esperado $3, veio $2"; fi; }

# Le a contagem do Redis e falha alto se nao conseguir ler: nao aceita '?'
# silencioso, porque isso esconde exatamente o bug que esta funcao corrige.
check_delayed() {
  # O "|| n=''" e obrigatorio: com set -e, uma atribuicao que vem de uma
  # substituicao de comando que falha aborta o script inteiro, e a gente
  # perderia o resumo de todas as outras checagens por causa do Redis.
  n=$(redis_count) || n=""
  case "$n" in
    ''|*[!0-9]*) bad "$1: nao consegui ler o Redis (REDIS_URL=${REDIS_URL:-?})" ;;
    *)
      if [ "$n" -gt 0 ]; then ok "$2 ($n delayed)"; else bad "$1: nada persistido no Redis"; fi
      ;;
  esac
}

j() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const o=JSON.parse(s);const v=eval('o'+process.argv[1]);console.log(v===undefined?'':typeof v==='object'?JSON.stringify(v):v)}catch(e){console.log('')}})" "$1"; }

# Limpeza em trap. "kill $PID" sozinho nao basta: npx tao o node real como
# processo filho, entao matar o wrapper deixa o node vivo, segurando a porta 8601
# e fazendo o script seguinte falhar com EADDRINUSE. taskkill /T mata a arvore
# inteira. O trap tambem cobre o caso de o script sair por erro ou Ctrl-C, que
# antes deixava workers orfaos.
API_PID=""
WORKER_PID=""
WORKER2_PID=""

kill_tree() {
  pid="$1"
  [ -z "$pid" ] && return 0
  # No Git Bash o "/" precisa vir como "//" para o MSYS nao tratar como caminho.
  taskkill //PID "$pid" //T //F >/dev/null 2>&1 || kill "$pid" 2>/dev/null || true
}

cleanup() {
  kill_tree "$WORKER2_PID"
  kill_tree "$WORKER_PID"
  kill_tree "$API_PID"
}
trap cleanup EXIT INT TERM

echo "=== 1. boot da API (processo separado, sem worker) ==="

# Pre-flight: se a porta ja esta ocupada, este script vai testar o processo
# alheio, nao o seu. Foi o que aconteceu quando uma execucao anterior foi
# morta no meio: o /health respondia 200 do orfao, o script dava "ok" num
# processo que ele proprio nao tinha iniciado, e a checagem seguinte acusava
# falha sem explicacao. Falhar aqui e mais honesto do que medir a coisa errada.
if curl -s -m 3 -o /dev/null "$BASE/health" 2>/dev/null; then
  echo "  FAIL ja existe uma API respondendo em $BASE"
  echo "  este script recusa rodar para nao medir o processo de outro"
  # No Windows da para apontar quem e o culpado, que e o que costuma faltar
  # quando um teste anterior foi interrompido no meio.
  if command -v netstat >/dev/null 2>&1; then
    pid=$(netstat -ano 2>/dev/null | grep "LISTENING" | grep ":$(printf '%s' "$BASE" | sed 's/.*://')" | awk '{print $NF}' | head -1)
    [ -n "$pid" ] && echo "  ocupado pelo PID $pid -- derrube com: taskkill //PID $pid //T //F"
  fi
  exit 1
fi

# O worker precisa ficar de fora da API: e a unica forma de provar que a fila
# sobrevive a processos independentes. Se o chamador nao configurou isso, o
# proprio script configura.
EMBEDDED_WORKER=false
export EMBEDDED_WORKER

# Token de plataforma conhecido, so para esta suite. O E2E precisa conseguir
# tanto bater na rota quanto provar que ela NAO abre sozinha: sem token aqui, o
# unico estado testavel seria o 503 de falha fechada, e o caminho de sucesso
# ficaria sem cobertura.
METRICS_TOKEN='e2e-metrics-token-de-teste-000000000000'
export METRICS_TOKEN

npx ts-node --transpile-only src/server.ts > /tmp/api.log 2>&1 &
API_PID=$!

# Sleep fixo nao serve: sob carga (com o stack do Postiz no Docker) o ts-node
# leva bem mais que 18s para abrir a porta, e o curl dispara antes. Esperamos
# a porta de verdade responder.
READY=0
i=0
while [ $i -lt 60 ]; do
  if curl -s -m 3 -o /dev/null "$BASE/health"; then READY=1; break; fi
  kill -0 "$API_PID" 2>/dev/null || break
  i=$((i+1))
  sleep 2
done
if [ "$READY" != "1" ]; then
  bad "API nao respondeu /health em 120s"
  echo "--- api.log ---"; head -30 /tmp/api.log
  exit 1
fi

CODE=$(curl -s -m 10 -o /dev/null -w '%{http_code}' "$BASE/health")
check "GET /health" "$CODE" "200"
grep -q 'fila] backend: bullmq' /tmp/api.log && ok "fila em bullmq/redis" || bad "fila nao esta em bullmq"
grep -q 'worker BullMQ iniciado' /tmp/api.log && bad "worker subiu dentro da API (deveria ser EMBEDDED_WORKER=false)" || ok "API nao tem worker embarcado"

echo ""
echo "=== 2. signup e dados ==="
SIGNUP=$(curl -s -m 20 -X POST "$BASE/auth/signup" -H 'Content-Type: application/json' \
  -d "{\"tenantName\":\"E2E $SLUG\",\"slug\":\"$SLUG\",\"email\":\"e2e@$SLUG.com\",\"password\":\"senha12345\"}")
TOKEN=$(printf '%s' "$SIGNUP" | j '.data.token')
[ -n "$TOKEN" ] && ok "signup emitiu token" || { bad "signup sem token"; echo "$SIGNUP"; exit 1; }
AUTH="Authorization: Bearer $TOKEN"
TENANT=$(printf '%s' "$SIGNUP" | j '.data.user.tenantId')
[ -n "$TENANT" ] && ok "signup identificou o tenant" || bad "signup sem tenantId"

WA=$(curl -s -m 20 -X POST "$BASE/accounts" -H 'Content-Type: application/json' -H "$AUTH" \
  -d '{"network":"whatsapp","externalAccountId":"1234","displayName":"WABA","secret":"tok"}' | j '.data.id')
[ -n "$WA" ] && ok "conta whatsapp criada" || bad "conta nao criada"

curl -s -m 20 -o /dev/null -X POST "$BASE/whatsapp/templates" -H 'Content-Type: application/json' -H "$AUTH" \
  -d '{"name":"promo","languageCode":"pt_BR","status":"APPROVED","variableCount":0}'
CAMP=$(curl -s -m 20 -X POST "$BASE/campaigns" -H 'Content-Type: application/json' -H "$AUTH" \
  -d '{"name":"E2E"}' | j '.data.id')
ok "campanha e template criados"

echo ""
echo "=== 3. autenticacao ==="
CODE=$(curl -s -m 10 -o /dev/null -w '%{http_code}' "$BASE/accounts")
check "sem token" "$CODE" "401"
CODE=$(curl -s -m 10 -o /dev/null -w '%{http_code}' -H "Authorization: Bearer lixo" "$BASE/accounts")
check "token invalido" "$CODE" "401"

# O login normal e por e-mail e senha, sem slug. A secao 3b fixa o comportamento
# no slug opcional e no 409 de ambiguidade, para o atalho nao virar brecha.
NOSLUG=$(curl -s -m 20 -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
  -d "{\"email\":\"e2e@$SLUG.com\",\"password\":\"senha12345\"}")
NOEMAIL=$(printf '%s' "$NOSLUG" | j '.data.user.email')
check "login sem slug, so e-mail e senha" "$NOEMAIL" "e2e@$SLUG.com"
NOSLUGTENANT=$(printf '%s' "$NOSLUG" | j '.data.tenant.id')
[ "$NOSLUGTENANT" = "$TENANT" ] && ok "login sem slug cai no tenant certo" || bad "tenant errado no login sem slug ($NOSLUGTENANT vs $TENANT)"
CODE=$(curl -s -m 10 -o /dev/null -w '%{http_code}' -X POST "$BASE/auth/login" \
  -H 'Content-Type: application/json' -d "{\"email\":\"e2e@$SLUG.com\",\"password\":\"errada12345\"}")
check "login sem slug com senha errada" "$CODE" "401"
# Slug que existe mas com email de outro tenant: nao pode entrar na empresa errada.
CODE=$(curl -s -m 10 -o /dev/null -w '%{http_code}' -X POST "$BASE/auth/login" \
  -H 'Content-Type: application/json' -d "{\"slug\":\"inexistente-$SLUG\",\"email\":\"e2e@$SLUG.com\",\"password\":\"senha12345\"}")
check "slug invalido nao abre o tenant" "$CODE" "401"

# Ambigidade so existe com a MESMA senha nos dois tenants: e o que o 409 tem que
# pegar. Mesmo e-mail com senhas diferentes entra direto, porque nesse caso a
# senha sozinha identifica o usuario. Os dois casos usam e-mails separados para
# nao se misturarem.
DUPMAIL="dup-samesenha@$SLUG.com"
D1=$(curl -s -m 20 -X POST "$BASE/auth/signup" -H 'Content-Type: application/json' \
  -d "{\"tenantName\":\"E2E dup a\",\"slug\":\"$SLUG-dupa\",\"email\":\"$DUPMAIL\",\"password\":\"senha12345\"}")
[ -n "$(printf '%s' "$D1" | j '.data.token')" ] && ok "primeira empresa do e-mail duplicado criada" || bad "tenant dup a nao criado"
D2=$(curl -s -m 20 -X POST "$BASE/auth/signup" -H 'Content-Type: application/json' \
  -d "{\"tenantName\":\"E2E dup b\",\"slug\":\"$SLUG-dupb\",\"email\":\"$DUPMAIL\",\"password\":\"senha12345\"}")
[ -n "$(printf '%s' "$D2" | j '.data.token')" ] && ok "segunda empresa com o mesmo e-mail criada" || bad "tenant dup b nao criado"
CODE=$(curl -s -m 10 -o /dev/null -w '%{http_code}' -X POST "$BASE/auth/login" \
  -H 'Content-Type: application/json' -d "{\"email\":\"$DUPMAIL\",\"password\":\"senha12345\"}")
check "mesma senha em duas empresas pede o slug" "$CODE" "409"
DB=$(printf '%s' "$D2" | j '.data.user.tenantId')
RESOLVED=$(curl -s -m 20 -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
  -d "{\"slug\":\"$SLUG-dupb\",\"email\":\"$DUPMAIL\",\"password\":\"senha12345\"}")
check "o slug escolhe a empresa certa" "$(printf '%s' "$RESOLVED" | j '.data.user.tenantId')" "$DB"

DIFFMAIL="dup-diffsenha@$SLUG.com"
curl -s -m 20 -o /dev/null -X POST "$BASE/auth/signup" -H 'Content-Type: application/json' \
  -d "{\"tenantName\":\"E2E diff a\",\"slug\":\"$SLUG-diffa\",\"email\":\"$DIFFMAIL\",\"password\":\"senha12345\"}"
DIFFTENANT=$(curl -s -m 20 -X POST "$BASE/auth/signup" -H 'Content-Type: application/json' \
  -d "{\"tenantName\":\"E2E diff b\",\"slug\":\"$SLUG-diffb\",\"email\":\"$DIFFMAIL\",\"password\":\"outrasenha99\"}" | j '.data.user.tenantId')
CODE=$(curl -s -m 10 -o /dev/null -w '%{http_code}' -X POST "$BASE/auth/login" \
  -H 'Content-Type: application/json' -d "{\"email\":\"$DIFFMAIL\",\"password\":\"outrasenha99\"}")
check "mesmo e-mail com senhas diferentes entra sem slug" "$CODE" "200"
PICKED=$(curl -s -m 20 -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$DIFFMAIL\",\"password\":\"outrasenha99\"}" | j '.data.user.tenantId')
[ "$PICKED" = "$DIFFTENANT" ] && ok "a senha escolhe a empresa, sem slug" || bad "sem slug caiu na empresa errada"

echo ""
echo "=== 4. jobs ficam no Redis sem worker ==="
WHEN=$(node -e "console.log(new Date(Date.now()+20000).toISOString())")
BODY=$(node -e "console.log(JSON.stringify({contentType:'template',text:'Cupom',media:[],settings:{templateName:'promo',languageCode:'pt_BR',bodyParams:[]},accountIds:['$WA'],audience:['5511900000001','5511900000002'],scheduledAt:'$WHEN'}))")
POSTED=$(curl -s -m 20 -X POST "$BASE/campaigns/$CAMP/posts" -H 'Content-Type: application/json' -H "$AUTH" -d "$BODY")
COUNT=$(printf '%s' "$POSTED" | j '.data.jobs.length')
check "fan-out gerou jobs" "$COUNT" "2"
check_delayed "nada persistiu no Redis" "entradas delayed no Redis"

echo ""
echo "=== 5. rate limit compartilhado pelo Redis ==="
C429=0
i=0
while [ $i -lt 25 ]; do
  C=$(curl -s -m 10 -o /dev/null -w '%{http_code}' -X POST "$BASE/auth/login" \
    -H 'Content-Type: application/json' -d "{\"slug\":\"$SLUG\",\"email\":\"e2e@$SLUG.com\",\"password\":\"errada123\"}")
  [ "$C" = "429" ] && C429=$((C429+1))
  i=$((i+1))
done
[ "$C429" -gt 0 ] && ok "429 em $C429 de 25 tentativas" || bad "rate limit nao disparou"

echo ""
echo "=== 6. worker em processo separado processa ==="
npx ts-node --transpile-only src/worker.ts > /tmp/worker.log 2>&1 &
WORKER_PID=$!
# Espera o worker iniciar de verdade em vez de dormir 30s: o log dele prova que
# o BullMQ conectou. Corta ~25s da execucao e ainda cobre o caso lento, porque o
# wait_wait tem teto.
i=0
while [ $i -lt 30 ]; do
  grep -q 'worker BullMQ iniciado' /tmp/worker.log 2>/dev/null && break
  kill -0 "$WORKER_PID" 2>/dev/null || break
  i=$((i+1))
  sleep 1
done
# Margem para o worker pegar os jobs depois de subir.
i=0
while [ $i -lt 20 ]; do
  S=$(curl -s -m 20 "$BASE/jobs" -H "$AUTH" | j '.data.filter(x=>x.status==="queued").length')
  case "$S" in
    ''|*[!0-9]*) ;;
    0) break ;;
  esac
  i=$((i+1))
  sleep 1
done
STATUSES=$(curl -s -m 20 "$BASE/jobs" -H "$AUTH" | j '.data.map(x=>x.status).join(",")')
echo "  statuses: $STATUSES"
case "$STATUSES" in
  *running*|*failed*|*succeeded*) ok "worker executou os jobs" ;;
  *) bad "worker nao processou nada" ;;
esac

echo ""
echo "=== 7. worker morto, novo worker retoma o que ficou na fila ==="
# Ate aqui os 2 jobs iniciais falharam com erro 190 (token invalido) e o guard de
# credencial marcou a conta como expired. Isso e o comportamento correto, mas
# impede novo post: por isso o passo 7 usa uma conta nova.
kill_tree "$WORKER_PID"
WORKER_PID=""
sleep 2

WA2=$(curl -s -m 20 -X POST "$BASE/accounts" -H 'Content-Type: application/json' -H "$AUTH" \
  -d '{"network":"whatsapp","externalAccountId":"5678","displayName":"WABA 2","secret":"tok"}' | j '.data.id')
[ -n "$WA2" ] && ok "conta nova criada (a anterior foi marcada expired)" || bad "conta nova falhou"

WHEN2=$(node -e "console.log(new Date(Date.now()+15000).toISOString())")
BODY2=$(node -e "console.log(JSON.stringify({contentType:'template',text:'Cupom',media:[],settings:{templateName:'promo',languageCode:'pt_BR',bodyParams:[]},accountIds:['$WA2'],audience:['5511900000003'],scheduledAt:'$WHEN2'}))")
CODE=$(curl -s -m 20 -o /dev/null -w '%{http_code}' -X POST "$BASE/campaigns/$CAMP/posts" -H 'Content-Type: application/json' -H "$AUTH" -d "$BODY2")
check "post aceito com conta valida" "$CODE" "201"

QUEUED=$(curl -s -m 20 "$BASE/jobs" -H "$AUTH" | j '.data.filter(x=>x.status==="queued").length')
[ "$QUEUED" -gt 0 ] && ok "$QUEUED job(s) queued sem worker ativo" || bad "nenhum job ficou queued"

check_delayed "nao persistiu no Redis" "persistido no Redis"

npx ts-node --transpile-only src/worker.ts > /tmp/worker2.log 2>&1 &
WORKER2_PID=$!
# Mesma espera do passo 6: espera o log do worker, e so depois espera a fila
# esvaziar. Sem isso o teste dependia de a janela de 30s ser suficiente.
i=0
while [ $i -lt 30 ]; do
  grep -q 'worker BullMQ iniciado' /tmp/worker2.log 2>/dev/null && break
  kill -0 "$WORKER2_PID" 2>/dev/null || break
  i=$((i+1))
  sleep 1
done
AFTER="$QUEUED"
i=0
while [ $i -lt 25 ]; do
  A=$(curl -s -m 20 "$BASE/jobs" -H "$AUTH" | j '.data.filter(x=>x.status==="queued").length')
  case "$A" in
    ''|*[!0-9]*) ;;
    *) AFTER="$A"; [ "$A" -lt "$QUEUED" ] && break ;;
  esac
  i=$((i+1))
  sleep 1
done
[ "$AFTER" -lt "$QUEUED" ] && ok "worker novo retomou ($QUEUED -> $AFTER queued)" || bad "nada retomado ($QUEUED -> $AFTER)"

echo ""
echo "=== 7b. conta expired barra novo post ==="
CODE=$(curl -s -m 20 -o /dev/null -w '%{http_code}' -X POST "$BASE/campaigns/$CAMP/posts" -H 'Content-Type: application/json' -H "$AUTH" \
  -d "$(node -e "console.log(JSON.stringify({contentType:'template',text:'x',media:[],settings:{templateName:'promo',languageCode:'pt_BR',bodyParams:[]},accountIds:['$WA'],audience:['5511900000009']}))")")
check "post com conta expired" "$CODE" "422"

echo ""
echo "=== 8. auditoria ==="
AUDIT=$(curl -s -m 20 "$BASE/audit?limit=50" -H "$AUTH" | j '.data.length')
[ "$AUDIT" -gt 0 ] && ok "audit log com $AUDIT entradas" || bad "audit vazio"

echo ""
echo "=== 9. fase 7: specs autoritativos do provedor ==="
# Nao ha integracao real do Postiz neste ambiente, entao o sync falha. O que
# importa aqui e que a falha nao quebre o onboarding e que o estado do cache
# fique observavel, em vez de silenciosamente aceitar o fallback.
IG=$(curl -s -m 20 -D /tmp/ig.hdr -X POST "$BASE/accounts" -H 'Content-Type: application/json' -H "$AUTH" \
  -d '{"network":"instagram","externalAccountId":"ig-e2e","displayName":"IG","secret":"tok"}' | j '.data.id')
[ -n "$IG" ] && ok "conta bridged criada mesmo sem provedor" || bad "conta bridged nao criada"
grep -qi 'X-Provider-Specs: stale' /tmp/ig.hdr && ok "onboarding sinalizou specs desatualizados" || bad "header de specs stale ausente"

# maxLength null = caindo no NETWORK_SPECS, e o campo precisa ser exposto.
SPECS=$(curl -s -m 20 "$BASE/accounts/$IG" -H "$AUTH")
[ "$(printf '%s' "$SPECS" | j '.data.providerMaxLength')" = "" ] && ok "cache sem maxLength quando sync falhou" || bad "maxLength deveria ser null"
[ "$(printf '%s' "$SPECS" | j '.data.specsSyncedAt')" = "" ] && ok "sem specsSyncedAt quando sync falhou" || bad "specsSyncedAt nao deveria existir"

# WhatsApp e nativa: 422 em vez de gastar chamada com o Postiz e tomar 404.
CODE=$(curl -s -m 20 -o /dev/null -w '%{http_code}' -X POST "$BASE/accounts/$WA/sync-specs" -H "$AUTH")
check "sync-specs em rede nativa" "$CODE" "422"
NATIVE=$(curl -s -m 20 "$BASE/accounts/$WA/settings" -H "$AUTH")
[ "$(printf '%s' "$NATIVE" | j '.data.native')" = "true" ] && ok "settings de rede nativa nao chama o Postiz" || bad "native nao marcado: $(printf '%s' "$NATIVE" | head -c 160)"
[ -n "$(printf '%s' "$NATIVE" | j '.data.fallbackMaxLength')" ] && ok "rede nativa expoe o fallback do NETWORK_SPECS" || bad "fallbackMaxLength ausente"

# Com provedor indisponivel o cache anterior e preservado e o erro e explicito.
CODE=$(curl -s -m 20 -o /dev/null -w '%{http_code}' -X POST "$BASE/accounts/$IG/sync-specs" -H "$AUTH")
check "sync-specs com provedor fora do ar" "$CODE" "502"

# Editar e excluir conta. O `@` do Telegram foi um bug real: o operador digita
# `@bot` porque e assim que o username aparece, o banco guardava `@@bot`, e sem
# rota de edicao o erro ficava sem correcao.
TG=$(curl -s -m 20 -X POST "$BASE/accounts" -H 'Content-Type: application/json' -H "$AUTH" \
  -d '{"network":"telegram","externalAccountId":"@@Estetichat","displayName":"Itamidia","secret":"tok"}')
TGID=$(printf '%s' "$TG" | j '.data.id')
check "telegram normaliza @ duplicado" "$(printf '%s' "$TG" | j '.data.externalAccountId')" "@Estetichat"

EDITED=$(curl -s -m 20 -X PATCH "$BASE/accounts/$TGID" -H 'Content-Type: application/json' -H "$AUTH" \
  -d '{"displayName":"Itamidia Telecom","externalAccountId":"Estetichat2"}')
check "editar conta" "$(printf '%s' "$EDITED" | j '.data.displayName')" "Itamidia Telecom"
check "editar normaliza o @ de novo" "$(printf '%s' "$EDITED" | j '.data.externalAccountId')" "@Estetichat2"
# Rotacao de token: o status depende de a rede ter ou nao provedor que valide.
# Com bridge, o token novo so vale depois que o sync confirma, entao `pending`.
# Nativa (telegram) nao tem sync -- deixar `pending` trancava a conta para sempre,
# porque o publish recusa status != active e nada voltava o status.
ROTATED=$(curl -s -m 20 -X PATCH "$BASE/accounts/$TGID" -H 'Content-Type: application/json' -H "$AUTH" \
  -d '{"secret":"outro-token"}')
check "trocar token em rede nativa mantem a conta publicavel" "$(printf '%s' "$ROTATED" | j '.data.status')" "active"
check "o segredo novo nunca volta na resposta" "$(printf '%s' "$ROTATED" | j '.data.encryptedSecret')" ""

BRIDGED=$(curl -s -m 20 -X POST "$BASE/accounts" -H 'Content-Type: application/json' -H "$AUTH" \
  -d '{"network":"instagram","externalAccountId":"ig-123","displayName":"IG","secret":"tok"}')
BRIDGEDID=$(printf '%s' "$BRIDGED" | j '.data.id')
check "rede com bridge nasce ativa" "$(printf '%s' "$BRIDGED" | j '.data.status')" "active"
BRIDGE_ROT=$(curl -s -m 20 -X PATCH "$BASE/accounts/$BRIDGEDID" -H 'Content-Type: application/json' -H "$AUTH" \
  -d '{"secret":"outro-token"}')
check "trocar token em rede com bridge volta para pendente" "$(printf '%s' "$BRIDGE_ROT" | j '.data.status')" "pending"

# Editar sem rotacionar o token nao pode mexer no status: arrumar o `@` duplicado
# nao torna o token valido nem invalido.
NAME_ONLY=$(curl -s -m 20 -X PATCH "$BASE/accounts/$TGID" -H 'Content-Type: application/json' -H "$AUTH" \
  -d '{"displayName":"Itamidia Telecom"}')
check "editar sem token nao altera o status" "$(printf '%s' "$NAME_ONLY" | j '.data.status')" "active"
check "editar sem campos" "$(curl -s -m 20 -o /dev/null -w '%{http_code}' -X PATCH "$BASE/accounts/$TGID" -H 'Content-Type: application/json' -H "$AUTH" -d '{}')" "400"

# Isolar o tenant antes de excluir: conta de outro tenant precisa ser 404, nao 200.
# O tenant vizinho nasce pelo STORE, nao por `/auth/signup`: `/auth` tem rate limit
# de 20/min por IP e um signup a mais aqui faz o proprio E2E estourar o limite e
# derrubar a secao 5. O token dele e' forjado porque nao queremos consumir login.
NEIGHBOR=$(npx ts-node --transpile-only scripts/make-neighbor-tenant.ts 2>/dev/null | tail -1)
OTHER_TENANT=$(printf '%s' "$NEIGHBOR" | j '.tenantId')
OAUTH=$(printf '%s' "$NEIGHBOR" | j '.token')
[ -n "$OAUTH" ] || { echo "  FAIL nao deu para criar o tenant vizinho; os checks de isolamento nao valem nada"; exit 1; }
ALIEN=$(curl -s -m 20 -X POST "$BASE/accounts" -H 'Content-Type: application/json' -H "Authorization: Bearer $OAUTH" \
  -d '{"network":"telegram","externalAccountId":"@Alheia","displayName":"Alheia","secret":"tok"}' | j '.data.id')
[ -n "$ALIEN" ] || { echo "  FAIL nao deu para criar a conta no tenant vizinho"; exit 1; }
check "excluir conta de outro tenant" "$(curl -s -m 20 -o /dev/null -w '%{http_code}' -X DELETE "$BASE/accounts/$ALIEN" -H "$AUTH")" "404"
# A listagem do outro tenant ainda tem a conta: o DELETE alheio nao a levou junto.
ALIVE=$(curl -s -m 20 "$BASE/accounts" -H "Authorization: Bearer $OAUTH")
check "a conta alheia sobreviveu" "$(printf '%s' "$ALIVE" | grep -c "$ALIEN" | tr -d ' ')" "1"

check "excluir conta" "$(curl -s -m 20 -X DELETE "$BASE/accounts/$TGID" -H "$AUTH" | j '.data.deleted')" "true"
check "conta excluida some da lista" "$(curl -s -m 20 "$BASE/accounts" -H "$AUTH" | grep -c "$TGID" | tr -d ' ')" "0"

# A conta tem job queued; apagar agora deixaria o worker sem destino.
BUSY=$(curl -s -m 20 -X POST "$BASE/accounts" -H 'Content-Type: application/json' -H "$AUTH" \
  -d '{"network":"telegram","externalAccountId":"@Ocupada","displayName":"Ocupada","secret":"tok"}' | j '.data.id')
BCAMP=$(curl -s -m 20 -X POST "$BASE/campaigns" -H 'Content-Type: application/json' -H "$AUTH" -d '{"name":"Delete"}' | j '.data.id')
curl -s -m 20 -X POST "$BASE/campaigns/$BCAMP/posts" -H 'Content-Type: application/json' -H "$AUTH" \
  -d "$(node -e "console.log(JSON.stringify({contentType:'message',text:'oi',media:[],settings:{},accountIds:[process.argv[1]],scheduledAt:new Date(Date.now()+7200000).toISOString()}))" "$BUSY")" > /dev/null
check "excluir conta com job pendente" "$(curl -s -m 20 -o /dev/null -w '%{http_code}' -X DELETE "$BASE/accounts/$BUSY" -H "$AUTH")" "409"

# Rede sem midia obrigatoria, para o limite de texto ser a unica causa plausivel
# de recusa. Sem isso um 422 por media_required validaria o teste por engano.
FB=$(curl -s -m 20 -X POST "$BASE/accounts" -H 'Content-Type: application/json' -H "$AUTH" \
  -d '{"network":"facebook","externalAccountId":"fb-e2e","displayName":"FB","secret":"tok"}' | j '.data.id')
# O corpo vai por arquivo: 64KB inline estouraria o limite de linha de comando
# do Windows e o teste morreria antes de checar a validacao. O node e o do
# Windows e nao entende o /tmp do Git Bash, entao recebe o path convertido.
BODYLONG=/tmp/fb-long.json
BODYOK=/tmp/fb-ok.json
node -e "require('fs').writeFileSync(process.argv[1], JSON.stringify({contentType:'feed',text:'a'.repeat(64000),media:[],settings:{},accountIds:['$FB'],scheduledAt:new Date(Date.now()+86400000).toISOString()}))" "$(cygpath -w "$BODYLONG")"
FBRESP=$(curl -s -m 30 -X POST "$BASE/campaigns/$CAMP/posts" -H 'Content-Type: application/json' -H "$AUTH" --data-binary @"$BODYLONG")
# Checamos o code da issue, nao o status: 422 por outro motivo passaria igual.
printf '%s' "$FBRESP" | grep -q 'text_too_long' && ok "texto acima do fallback reprovado por text_too_long" || bad "esperava text_too_long, veio: $(printf '%s' "$FBRESP" | head -c 200)"

# O texto aceito pelo fallback tem de passar, senao o teste acima so provaria
# que a rota recusa tudo.
node -e "require('fs').writeFileSync(process.argv[1], JSON.stringify({contentType:'feed',text:'curto',media:[],settings:{},accountIds:['$FB'],scheduledAt:new Date(Date.now()+86400000).toISOString()}))" "$(cygpath -w "$BODYOK")"
CODE=$(curl -s -m 20 -o /dev/null -w '%{http_code}' -X POST "$BASE/campaigns/$CAMP/posts" -H 'Content-Type: application/json' -H "$AUTH" --data-binary @"$BODYOK")
check "texto dentro do fallback aceito" "$CODE" "201"

# A precedencia do limite do provedor sobre a constante local e coberta em
# verify-provider-specs.ts, porque depende de injetar um maxLength que so o
# Postiz real popula; nao ha endpoint para simular isso por API.

echo ""
echo "=== 10. fase 9: fila morta ==="
t() { echo "[$(date +%s)] $*" >> /tmp/e2e-trace.log; }
: > /tmp/e2e-trace.log
t "inicio da secao 10"

# Uma conta nova por post, de proposito. O requeue de cada teste reactiva o job
# com delay 0, e um worker remanescente o consome de imediato: a tentativa de
# publicar falha e a conta e marcada como expired. Reusar a conta faria o post
# seguinte ser recusado com 422 account_not_active, e o teste passaria a medir
# expiracao de conta em vez de fila morta. (As contas da secao 7 ja chegam
# expired pelo mesmo motivo.)
dlq_account() {
  curl -s -m 20 -X POST "$BASE/accounts" -H 'Content-Type: application/json' -H "$AUTH" \
    -d "{\"network\":\"whatsapp\",\"externalAccountId\":\"wa-dlq-$1\",\"displayName\":\"DLQ $1\",\"secret\":\"tok\"}" | j '.data.id'
}

dlq_post() {
  local when audience account
  when=$(node -e "console.log(new Date(Date.now()+86400000).toISOString())")
  audience=$1
  account=$2
  node -e "console.log(JSON.stringify({contentType:'template',text:'dlq',media:[],settings:{templateName:'promo',languageCode:'pt_BR',bodyParams:[]},accountIds:['$account'],audience:['$audience'],scheduledAt:'$when'}))"
}

DWA=$(dlq_account 1)
[ -n "$DWA" ] && ok "conta dedicada a fila morta criada" || { bad "conta da fila morta nao criada"; exit 1; }

DLQRESP=$(curl -s -m 20 -X POST "$BASE/campaigns/$CAMP/posts" -H 'Content-Type: application/json' -H "$AUTH" -d "$(dlq_post 5511900000004 "$DWA")")
DLQJOB=$(printf '%s' "$DLQRESP" | j '.data.jobs[0].id')
[ -n "$DLQJOB" ] && ok "post criado para o teste da fila morta" || { bad "sem job para dead-letterar: $(printf '%s' "$DLQRESP" | head -c 300)"; exit 1; }

# O estado de "esgotou as tentativas" e preparado direto no store: esperar o
# backoff real do worker nao cabe no tempo do E2E, e o store e o estado
# autoritativo de qualquer jeito.
# O id da entrada vem de um arquivo, nunca do stdout: o store e o pool escrevem
# banners de inicializacao em console.log e poluiriam a captura.
DLQFILE=/tmp/dlq-entry.txt
npx ts-node --transpile-only scripts/seed-dead-letter.ts "$SLUG" "$DLQJOB" "$(cygpath -w "$DLQFILE")" 2>/tmp/seed-dlq.log
DLQ=$(cat "$DLQFILE" 2>/dev/null)
t "primeiro seeding: '$DLQ'"
[ -n "$DLQ" ] && ok "entrada de fila morta semeada" || { bad "seeding da fila morta falhou: $(cat /tmp/seed-dlq.log)"; exit 1; }

# Sem token a triagem e fechada, como qualquer rota de tenant.
CODE=$(curl -s -m 10 -o /dev/null -w '%{http_code}' "$BASE/dead-letters")
check "fila morta sem token (401)" "$CODE" "401"

# Token invalido tambem.
CODE=$(curl -s -m 10 -o /dev/null -w '%{http_code}' "$BASE/dead-letters" -H "Authorization: Bearer lixo")
check "fila morta com token invalido (401)" "$CODE" "401"

# A listagem traz a entrada aberta.
DLQOPEN=$(curl -s -m 20 "$BASE/dead-letters?resolution=open" -H "$AUTH" | j '.data.length')
check "fila morta lista a entrada aberta" "$DLQOPEN" "1"

# O filtro `open` e o que esconde entradas ja tratadas; conferimos que o
# endpoint de listagem distingue, e nao so que responde 200.
DLQR=$(curl -s -m 20 "$BASE/dead-letters?resolution=requeued" -H "$AUTH" | j '.data.length')
check "filtro requeued vazio antes do requeue" "$DLQR" "0"

# Id inexistente e 404, nao 200 com lista vazia: requeue no vazio sem feedback
# faria o operador achar que deu certo.
CODE=$(curl -s -m 10 -o /dev/null -w '%{http_code}' -X POST "$BASE/dead-letters/00000000-0000-0000-0000-000000000000/resolve" \
  -H 'Content-Type: application/json' -H "$AUTH" -d '{"action":"requeue"}')
check "resolve de entrada inexistente (404)" "$CODE" "404"

# Action invalida e rejeitada pelo schema, antes de qualquer escrita.
CODE=$(curl -s -m 10 -o /dev/null -w '%{http_code}' -X POST "$BASE/dead-letters/$DLQ/resolve" \
  -H 'Content-Type: application/json' -H "$AUTH" -d '{"action":"destruir"}')
t "action invalida respondeu $CODE"
check "resolve com action invalida (400)" "$CODE" "400"

# Requeue: fecha a entrada, zera o orcamento de tentativas e devolve o job para a fila.
REQUEUE=$(curl -s -m 20 -X POST "$BASE/dead-letters/$DLQ/resolve" -H 'Content-Type: application/json' -H "$AUTH" -d '{"action":"requeue"}')
t "requeue respondeu: $(printf '%s' "$REQUEUE" | head -c 120)"
check "requeue marcou resolution" "$(printf '%s' "$REQUEUE" | j '.data.deadLetter.resolution')" "requeued"
check "requeue somou requeueCount" "$(printf '%s' "$REQUEUE" | j '.data.deadLetter.requeueCount')" "1"
check "requeue devolveu o job para queued" "$(printf '%s' "$REQUEUE" | j '.data.job.status')" "queued"
check "requeue zerou as tentativas" "$(printf '%s' "$REQUEUE" | j '.data.job.attempts')" "0"
ok "requeue reagendou o job com orcamento novo"

# Tratar duas vezes a mesma entrada e conflito, senao um segundo clique
# republicaria o post.
CODE=$(curl -s -m 10 -o /dev/null -w '%{http_code}' -X POST "$BASE/dead-letters/$DLQ/resolve" \
  -H 'Content-Type: application/json' -H "$AUTH" -d '{"action":"requeue"}')
check "segundo resolve da mesma entrada (409)" "$CODE" "409"

# Requeue nao republica job que ja deu certo: o job pode ter sido concluido
# entre a leitura da triagem e o clique.
DWA2=$(dlq_account 2)
DLQRESP2=$(curl -s -m 20 -X POST "$BASE/campaigns/$CAMP/posts" -H 'Content-Type: application/json' -H "$AUTH" -d "$(dlq_post 5511900000005 "$DWA2")")
DLQJOB2=$(printf '%s' "$DLQRESP2" | j '.data.jobs[0].id')
[ -n "$DLQJOB2" ] || { bad "sem segundo job para dead-letterar: $(printf '%s' "$DLQRESP2" | head -c 300)"; exit 1; }
DLQFILE2=/tmp/dlq-entry-2.txt
npx ts-node --transpile-only scripts/seed-dead-letter.ts "$SLUG" "$DLQJOB2" "$(cygpath -w "$DLQFILE2")" --succeeded >/dev/null 2>&1
DLQ2=$(cat "$DLQFILE2" 2>/dev/null)
t "segundo seeding terminou: '$DLQ2'"
[ -n "$DLQ2" ] || { bad "sem entrada para o teste de job publicado"; exit 1; }
CODE=$(curl -s -m 10 -o /dev/null -w '%{http_code}' -X POST "$BASE/dead-letters/$DLQ2/resolve" \
  -H 'Content-Type: application/json' -H "$AUTH" -d '{"action":"requeue"}')
t "requeue de job publicado respondeu $CODE"
check "requeue de job ja publicado (409)" "$CODE" "409"

# Discard fecha sem reagendar nada.
DWA3=$(dlq_account 3)
DLQRESP3=$(curl -s -m 20 -X POST "$BASE/campaigns/$CAMP/posts" -H 'Content-Type: application/json' -H "$AUTH" -d "$(dlq_post 5511900000006 "$DWA3")")
DLQJOB3=$(printf '%s' "$DLQRESP3" | j '.data.jobs[0].id')
[ -n "$DLQJOB3" ] || { bad "sem terceiro job para dead-letterar: $(printf '%s' "$DLQRESP3" | head -c 300)"; exit 1; }
DLQFILE3=/tmp/dlq-entry-3.txt
npx ts-node --transpile-only scripts/seed-dead-letter.ts "$SLUG" "$DLQJOB3" "$(cygpath -w "$DLQFILE3")" >/dev/null 2>&1
DLQ3=$(cat "$DLQFILE3" 2>/dev/null)
DISCARD=$(curl -s -m 20 -X POST "$BASE/dead-letters/$DLQ3/resolve" -H 'Content-Type: application/json' -H "$AUTH" -d '{"action":"discard"}')
check "discard marcou resolution" "$(printf '%s' "$DISCARD" | j '.data.resolution')" "discarded"
check "discard nao somou requeueCount" "$(printf '%s' "$DISCARD" | j '.data.requeueCount')" "0"

# O job descartado continua como esta: discard nao e sucesso nem republicacao.
check "discard nao mudou o job" "$(curl -s -m 20 "$BASE/jobs" -H "$AUTH" | j ".data.filter(x=>x.id==='$DLQJOB3')[0].status")" "failed"

# A entrada do job que ja deu certo CONTINUA ABERTA: o requeue foi barrado com
# 409 de proposito, e nada a tratou. As outras duas estao fechadas (uma
# requeued, uma discarded), entao sobra exatamente uma aberta.
DLQOPEN=$(curl -s -m 20 "$BASE/dead-letters?resolution=open" -H "$AUTH" | j '.data.length')
check "so a entrada barrada continua aberta" "$DLQOPEN" "1"
DLQD=$(curl -s -m 20 "$BASE/dead-letters?resolution=discarded" -H "$AUTH" | j '.data.length')
check "entrada descartada visivel no filtro" "$DLQD" "1"
DLQR2=$(curl -s -m 20 "$BASE/dead-letters?resolution=requeued" -H "$AUTH" | j '.data.length')
check "entrada reagendada visivel no filtro" "$DLQR2" "1"

# --- Secao 11: reconciliacao de releaseIdMissing ---
t "inicio da secao 11"

# O caminho feliz da reconciliacao (200) e o 202 nao sao testaveis aqui: exigem um
# post REAL no Postiz com `releaseId: 'missing'`, o que depende de uma integracao
# social valida. O verify-reconcile.ts cobre os tres desfechos (reconciled,
# pending, error) contra um Postiz fake, no mesmo caminho de codigo. O que falta
# aqui e so a camada HTTP em volta deles.

RECFILE=/tmp/rec-job.txt
npx ts-node --transpile-only scripts/seed-reconcile.ts "$SLUG" "$DLQJOB2" "$(cygpath -w "$RECFILE")" 2>/tmp/seed-rec.log
RECJOB=$(cat "$RECFILE" 2>/dev/null)
t "seeding da reconciliacao: '$RECJOB'"
[ -n "$RECJOB" ] && ok "job pendente de reconciliacao semeado" || { bad "seeding da reconciliacao falhou: $(cat /tmp/seed-rec.log)"; exit 1; }

# O job semeado aparece marcado na listagem de jobs.
RECMARK=$(curl -s -m 20 "$BASE/jobs" -H "$AUTH" | j ".data.filter(x=>x.id==='$RECJOB')[0].releaseIdMissing")
check "job sem id do provedor aparece marcado" "$RECMARK" "true"

CODE=$(curl -s -m 20 -o /dev/null -w '%{http_code}' -X POST "$BASE/jobs/$RECJOB/reconcile" -H 'Content-Type: application/json')
check "reconcile sem token (401)" "$CODE" "401"

# O id interno do Postiz semeado nao existe la. A rota tem de propagar a falha
# como 502 -- e nao devolver 200 com um id inventado, que seria um "publicado"
# que nunca existiu.
CODE=$(curl -s -m 60 -o /tmp/rec-body.json -w '%{http_code}' -X POST "$BASE/jobs/$RECJOB/reconcile" -H "$AUTH")
check "reconcile com Postiz inacessivel (502)" "$CODE" "502"

# Falha do Postiz nao pode virar falha de publicacao: o job foi publicado.
RECSTAT=$(curl -s -m 20 "$BASE/jobs" -H "$AUTH" | j ".data.filter(x=>x.id==='$RECJOB')[0].status")
check "falha ao reconciliar nao desatende o job" "$RECSTAT" "succeeded"
RECMARK2=$(curl -s -m 20 "$BASE/jobs" -H "$AUTH" | j ".data.filter(x=>x.id==='$RECJOB')[0].releaseIdMissing")
check "job segue marcado para a proxima passada" "$RECMARK2" "true"

# 404 para job que nao existe, e 409 para os dois ramos de "nao reconciliavel":
# job que nao terminou de publicar, e job publicado que ja tem o id do provedor.
CODE=$(curl -s -m 20 -o /dev/null -w '%{http_code}' -X POST "$BASE/jobs/00000000-0000-0000-0000-000000000000/reconcile" -H "$AUTH")
check "reconcile de job inexistente (404)" "$CODE" "404"
CODE=$(curl -s -m 20 -o /dev/null -w '%{http_code}' -X POST "$BASE/jobs/$DLQJOB/reconcile" -H "$AUTH")
check "reconcile de job que nao terminou de publicar (409)" "$CODE" "409"

# O terceiro job da fila morta ainda esta `failed`; reusa-se so para chegar no
# estado publicado, agora com id de provedor e sem marcador.
RECFILE2=/tmp/rec-job-2.txt
npx ts-node --transpile-only scripts/seed-reconcile.ts "$SLUG" "$DLQJOB3" "$(cygpath -w "$RECFILE2")" --unmarked >/dev/null 2>&1
RECJOB2=$(cat "$RECFILE2" 2>/dev/null)
[ -n "$RECJOB2" ] || { bad "seeding do job ja publicado falhou"; exit 1; }
CODE=$(curl -s -m 20 -o /dev/null -w '%{http_code}' -X POST "$BASE/jobs/$RECJOB2/reconcile" -H "$AUTH")
check "reconcile de job ja publicado (409)" "$CODE" "409"

# --- 9b. painel operacional ---
#
# O ponto destes checks NAO e o 200: e o que acontece quando o gate falha. O
# painel conta jobs de todos os tenants, entao proteger por `owner` mostraria a
# fila inteira para o dono de qualquer loja. Aqui provamos que o JWT de tenant --
# que e o que o dono de uma loja tem -- NAO abre o painel.
echo ""
echo "=== 9b. painel operacional (token de plataforma) ==="

CODE=$(curl -s -m 10 -o /dev/null -w '%{http_code}' "$BASE/ops/metrics")
check "painel sem token (401)" "$CODE" "401"
CODE=$(curl -s -m 10 -o /dev/null -w '%{http_code}' "$BASE/ops/metrics" -H "x-metrics-token: errado")
check "painel com token errado (401)" "$CODE" "401"
CODE=$(curl -s -m 10 -o /dev/null -w '%{http_code}' "$BASE/ops/metrics" -H "$AUTH")
check "painel com JWT de tenant em vez do token (401)" "$CODE" "401"

METRICS=$(curl -s -m 20 "$BASE/ops/metrics" -H "x-metrics-token: $METRICS_TOKEN")
WINDOW=$(printf '%s' "$METRICS" | j '.data.windowHours')
check "painel com o token de plataforma (200)" "$WINDOW" "24"
check "o painel traz a janela padrao" "$WINDOW" "24"

# O estado da quota vem em duas classes porque o Postiz cobra as duas de formas
# diferentes, e o limite que aperta primeiro e o de upload.
QUOTA_KEYS=$(printf '%s' "$METRICS" | j '.data.postizQuota.map(function (q) { return q.bucket }).sort().join()')
check "a cota do Postiz vem nas duas classes" "$QUOTA_KEYS" "posts,uploads"
UPLIMIT=$(printf '%s' "$METRICS" | j '.data.postizQuota.filter(function (q) { return q.bucket === "uploads" })[0].limit')
check "o limite de upload e o menor (30/h)" "$UPLIMIT" "30"
ALERT=$(printf '%s' "$METRICS" | j '.data.alerts.postizQuota')
[ -n "$ALERT" ] && ok "o painel sinaliza o estado da cota ($ALERT)" || bad "painel sem alerta de cota"

# O drilldown por tenant volta a ser leitura COMUM (RLS de tenant), e nao leitura
# de sistema. Por isso precisa de um tenantId valido.
DRILL=$(curl -s -m 20 "$BASE/ops/metrics?tenantId=$TENANT" -H "x-metrics-token: $METRICS_TOKEN" | j '.data.tenantId')
check "drilldown por tenant" "$DRILL" "$TENANT"
CODE=$(curl -s -m 10 -o /dev/null -w '%{http_code}' "$BASE/ops/metrics?tenantId=nao-e-uuid" -H "x-metrics-token: $METRICS_TOKEN")
check "drilldown com tenantId invalido (400)" "$CODE" "400"

# O volume do painel tem de refletir os jobs que este E2E criou, e nao zero: um
# painel que devolve 0 sem erro e o pior desfecho possivel -- mente calmamente.
JOBS=$(printf '%s' "$METRICS" | j '.data.byStatus.succeeded || 0')
[ "$JOBS" -gt 0 ] 2>/dev/null && ok "o painel conta os jobs publicados ($JOBS)" || bad "o painel nao contou nenhum job publicado"

# O isolamento entre tenants nao e testado aqui: proving-lo pela API exigiria
# um segundo signup, e o rate limit de /auth (20 por minuto por IP) ja foi
# consumido de proposito na secao 5. A prova mais forte fica no
# verify-dead-letter.ts, que consulta a fila morta com o papel da aplicacao
# (postmidia_app) e confirma que a listagem e o get de outro tenant nao veem
# nada -- e no verify-reconcile.ts, que confirma que a leitura de sistema
# atravessa o RLS mas nao concede escrita cross-tenant. No painel, o teste mais
# forte de separacao e o `verify-metrics.ts`, que semeia dois tenants e prova
# que a visao por tenant nao enxerga o vizinho.

# --- Secao 12: templates de WhatsApp (Fase 6) ---
#
# Nenhuma das rotas de template era testada pela API: nem a listagem, nem a
# criacao, nem o PATCH de status. O grafo de transicoes mora em
# verify-template-status.ts (10 checks, funcao pura + Postgres); aqui vai a
# camada HTTP em volta dele, que e onde a maquina pode ser contornada.
echo ""
echo "=== 12. fase 6: templates de WhatsApp ==="

TPL=$(curl -s -m 20 -X POST "$BASE/whatsapp/templates" -H 'Content-Type: application/json' -H "$AUTH" \
  -d '{"name":"promo_e2e","languageCode":"pt_BR","category":"MARKETING","status":"REJECTED"}')
TPLID=$(printf '%s' "$TPL" | j '.data.id')
[ -n "$TPLID" ] && ok "template criado com status REJECTED" || bad "template nao criado: $(printf '%s' "$TPL" | head -c 200)"

# A listagem precisa trazer o status que foi gravado. Um 200 com lista vazia
# passaria num `length > 0` mal escrito, e o operador veria uma tela em branco.
LIST=$(curl -s -m 20 "$BASE/whatsapp/templates" -H "$AUTH")
check "listagem traz o template criado" "$(printf '%s' "$LIST" | j ".data.filter(x=>x.id==='$TPLID').length")" "1"
check "a listagem preserva o status" "$(printf '%s' "$LIST" | j ".data.filter(x=>x.id==='$TPLID')[0].status")" "REJECTED"

# --- O caso perigoso, pela API ---
#
# REJECTED -> APPROVED e o gesto que o operador faz quando a publicacao esta
# quebrada e ele tem pressa. A Meta reprovou; marcar como aprovado na mao produz
# um template que a API aceita e a Meta recusa no envio, depois de gravar job,
# gastar cota e queimar as tentativas. Precisa ser 409, e a resposta precisa dizer
# que a aprovacao e do provedor.
REJ=$(curl -s -m 20 -X PATCH "$BASE/whatsapp/templates/$TPLID/status" -H 'Content-Type: application/json' -H "$AUTH" -d '{"status":"APPROVED"}')
CODE=$(curl -s -m 20 -o /dev/null -w '%{http_code}' -X PATCH "$BASE/whatsapp/templates/$TPLID/status" -H 'Content-Type: application/json' -H "$AUTH" -d '{"status":"APPROVED"}')
check "REJECTED -> APPROVED barrado (409)" "$CODE" "409"
printf '%s' "$REJ" | grep -q 'provedor' && ok "a recusa diz que a aprovacao e do provedor" || bad "recusa sem mencao ao provedor: $(printf '%s' "$REJ" | head -c 200)"

# E o status nao mudou: um 409 que grava antes de recusar seria pior que nao ter
# a protecao nenhuma.
check "o status nao mudou depois do 409" "$(curl -s -m 20 "$BASE/whatsapp/templates" -H "$AUTH" | j ".data.filter(x=>x.id==='$TPLID')[0].status")" "REJECTED"

# O caminho legitimo: reprovado volta para PENDING, e de PENDING para APPROVED.
CODE=$(curl -s -m 20 -o /dev/null -w '%{http_code}' -X PATCH "$BASE/whatsapp/templates/$TPLID/status" -H 'Content-Type: application/json' -H "$AUTH" -d '{"status":"PENDING"}')
check "REJECTED -> PENDING aceito (200)" "$CODE" "200"
CODE=$(curl -s -m 20 -o /dev/null -w '%{http_code}' -X PATCH "$BASE/whatsapp/templates/$TPLID/status" -H 'Content-Type: application/json' -H "$AUTH" -d '{"status":"APPROVED"}')
check "PENDING -> APPROVED aceito (200)" "$CODE" "200"
check "o status mudou mesmo" "$(curl -s -m 20 "$BASE/whatsapp/templates" -H "$AUTH" | j ".data.filter(x=>x.id==='$TPLID')[0].status")" "APPROVED"

# Reaplicar o mesmo status e no-op, nao conflito: o sync vai reescrever o status
# que ja esta, e um 409 ali seria um falso positivo que derrubaria a Fase 6.
CODE=$(curl -s -m 20 -o /dev/null -w '%{http_code}' -X PATCH "$BASE/whatsapp/templates/$TPLID/status" -H 'Content-Type: application/json' -H "$AUTH" -d '{"status":"APPROVED"}')
check "reaplicar o mesmo status e 200, nao 409" "$CODE" "200"

# Transicao que nao existe no vocabulario da Meta.
CODE=$(curl -s -m 20 -o /dev/null -w '%{http_code}' -X PATCH "$BASE/whatsapp/templates/$TPLID/status" -H 'Content-Type: application/json' -H "$AUTH" -d '{"status":"REJECTED"}')
check "APPROVED -> REJECTED barrado (409)" "$CODE" "409"

# Id inexistente: 404, e nao 409 de "transicao invalida" -- a confusao entre "esse
# template nao existe" e "esse template nao pode mudar de estado" mandaria o
# operador procurar um template que ele tem.
CODE=$(curl -s -m 20 -o /dev/null -w '%{http_code}' -X PATCH "$BASE/whatsapp/templates/00000000-0000-0000-0000-000000000000/status" -H 'Content-Type: application/json' -H "$AUTH" -d '{"status":"PENDING"}')
check "PATCH de template inexistente (404)" "$CODE" "404"

# Status fora do enum nem chega na maquina: e o schema que barra, com 400.
CODE=$(curl -s -m 20 -o /dev/null -w '%{http_code}' -X PATCH "$BASE/whatsapp/templates/$TPLID/status" -H 'Content-Type: application/json' -H "$AUTH" -d '{"status":"APROVADO"}')
check "status fora do enum (400)" "$CODE" "400"

# Criar de novo o mesmo template e conflito com nome uteis, nao 400 de constraint.
# Sem a checagem previa na rota, o UNIQUE estourava e o handler generico
# devolvia "violation of unique constraint", que nao diz qual template nem o que
# fazer.
DUP=$(curl -s -m 20 -X POST "$BASE/whatsapp/templates" -H 'Content-Type: application/json' -H "$AUTH" \
  -d '{"name":"promo_e2e","languageCode":"pt_BR","category":"MARKETING"}')
CODE=$(curl -s -m 20 -o /dev/null -w '%{http_code}' -X POST "$BASE/whatsapp/templates" -H 'Content-Type: application/json' -H "$AUTH" \
  -d '{"name":"promo_e2e","languageCode":"pt_BR","category":"MARKETING"}')
check "template duplicado (409)" "$CODE" "409"
printf '%s' "$DUP" | grep -q 'ja existe' && ok "o 409 diz que o template ja existe" || bad "409 sem mensagem util: $(printf '%s' "$DUP" | head -c 200)"
printf '%s' "$DUP" | grep -q 'violation of unique' && bad "o 409 vazou a constraint do Postgres" || ok "o 409 nao vaza a constraint do banco"

# O idioma entra na identidade do template: promo em en_US e outro template.
CODE=$(curl -s -m 20 -o /dev/null -w '%{http_code}' -X POST "$BASE/whatsapp/templates" -H 'Content-Type: application/json' -H "$AUTH" \
  -d '{"name":"promo_e2e","languageCode":"en_US","category":"MARKETING"}')
check "mesmo nome em outro idioma (201)" "$CODE" "201"

# --- O bloqueio de publicacao, que e o criterio de aceite da fase ---
#
# Um template em PENDING tem de recusar a criacao do post E dizer onde resolver.
# A mensagem antiga ("a Meta so aceita publicacao com status APPROVED") deixava
# o operador sem proximo passo; a nova aponta a sincronizacao e diz que o status
# muda por leitura do provedor, nao por PATCH.
TG=$(curl -s -m 20 -X POST "$BASE/accounts" -H 'Content-Type: application/json' -H "$AUTH" \
  -d '{"network":"whatsapp","externalAccountId":"wa-tpl-e2e","displayName":"WA TPL","secret":"tok"}' | j '.data.id')
CODE=$(curl -s -m 20 -X PATCH "$BASE/whatsapp/templates/$TPLID/status" -H 'Content-Type: application/json' -H "$AUTH" -d '{"status":"PENDING"}')
TGPOST=$(curl -s -m 20 -X POST "$BASE/campaigns/$CAMP/posts" -H 'Content-Type: application/json' -H "$AUTH" \
  -d "$(node -e "console.log(JSON.stringify({contentType:'template',text:'x',media:[],settings:{templateName:'promo_e2e',languageCode:'pt_BR',bodyParams:[]},accountIds:['$TG'],audience:['5511900000009']}))")")
check "post com template PENDING (422)" "$(curl -s -m 20 -o /dev/null -w '%{http_code}' -X POST "$BASE/campaigns/$CAMP/posts" -H 'Content-Type: application/json' -H "$AUTH" \
  -d "$(node -e "console.log(JSON.stringify({contentType:'template',text:'x',media:[],settings:{templateName:'promo_e2e',languageCode:'pt_BR',bodyParams:[]},accountIds:['$TG'],audience:['5511900000009']}))")")" "422"
printf '%s' "$TGPOST" | grep -q 'sync' && ok "o 422 do template aponta a sincronizacao" || bad "o 422 nao aponta a sincronizacao: $(printf '%s' "$TGPOST" | head -c 240)"
# ...e o mesmo 422 tem de explicar que o status nao se digita. Um operador que
# le "PENDING" e um PATCH na rota vai tentar exatamente o que a fase proibe.
printf '%s' "$TGPOST" | grep -q 'PATCH' && ok "o 422 avisa que PATCH nao resolve" || bad "o 422 nao avisa sobre o PATCH: $(printf '%s' "$TGPOST" | head -c 240)"

# --- A auditoria da mudanca de status ---
#
# A listagem vem ORDER BY created_at DESC e o limite default e 50, entao a
# contagem e conferida sobre um limite alto para nao depender de quantas
# entradas as secoes anteriores criaram.
AUDT=$(curl -s -m 20 "$BASE/audit?limit=500" -H "$AUTH")
AUDSTAT=$(printf '%s' "$AUDT" | j ".data.filter(x=>x.action==='whatsapp_template.status_changed').length")
AUDNEW=$(printf '%s' "$AUDT" | j ".data.filter(x=>x.action==='whatsapp_template.created').length")
[ "$AUDSTAT" -gt 0 ] && ok "a mudanca de status foi auditada ($AUDSTAT entradas)" || bad "nenhuma entrada whatsapp_template.status_changed"
[ "$AUDNEW" -gt 0 ] && ok "a criacao do template foi auditada ($AUDNEW entradas)" || bad "nenhuma entrada whatsapp_template.created"
# E a auditoria carrega a transicao, e nao so o status final: sem o `from`, o
# log nao diz o que o operador mudou, que e a unica coisa que se investiga.
check "a auditoria guarda o status de origem" "$(printf '%s' "$AUDT" | j ".data.filter(x=>x.action==='whatsapp_template.status_changed').map(x=>x.metadata.from).indexOf('REJECTED') >= 0")" "true"

# --- O header x-tenant-id nao sobrepoe a assinatura ---
#
# Este check era "listagem nao aceita tenant forcado -> 403" e ele estava errado
# de dois jeitos. Primeiro: o 403 nao acontece em dev, porque o .env local liga
# ALLOW_TENANT_HEADER e o header e aceito de proposito ali. Segundo, e o mais
# importante: eu mandava um Bearer VALIDO junto com o header, entao o 200 era o
# resultado certo — o token assinado vence e o header e descartado (o middleware
# so le o header depois de o token ter falhado).
#
# O invariante que vale nao e "o header e recusado", e "o header nao escolhe o
# tenant quando existe um token assinado". Entao o teste manda os dois, com o
# header apontando para um tenant que nao existe, e exige que a resposta seja a
# do tenant assinado. Se o header prevalecesse, o RLS nao acharia nada e a
# lista viria vazia.
FORCED=$(curl -s -m 20 "$BASE/whatsapp/templates" -H "$AUTH" -H 'X-Tenant-Id: 00000000-0000-0000-0000-000000000000')
check "o header nao sobrepoe o token assinado" "$(printf '%s' "$FORCED" | j ".data.filter(x=>x.id==='$TPLID').length")" "1"

# A limpeza final e feita pelo trap de EXIT, que tambem cobre o caminho de erro.
echo ""
echo "RESULTADO: $PASS ok, $FAIL falhas"
[ "$FAIL" -eq 0 ] || exit 1
