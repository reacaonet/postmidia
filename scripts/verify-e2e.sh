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

# A limpeza final e feita pelo trap de EXIT, que tambem cobre o caminho de erro.
echo ""
echo "RESULTADO: $PASS ok, $FAIL falhas"
[ "$FAIL" -eq 0 ] || exit 1
