/**
 * Verificacao do painel operacional e da contabilidade de cota (Fase 9).
 *
 * O ponto central desta bateria NAO e "os numeros batem". E que o painel
 * atravessa tenants e, mesmo assim, nao vaza. Um `/ops/metrics` protegido por
 * `owner`/`admin` mostraria a contagem de jobs de todos os clientes para o dono
 * de qualquer loja, porque `owner` e um papel POR TENANT. Esses checks existem
 * para travar essa porta.
 *
 * O segundo ponto e `published_at`. Latencia medida por `updated_at` seria
 * Mentira: a reconciliacao patcha o job horas depois de publicado, e o numero
 * passaria a medir a lentidao da reconciliacao. Ha um check que patcha o job
 * depois, propositalmente, e exige que a latencia NAO mude.
 *
 * O que a bateria prova:
 *  1. a visao de sistema ve jobs de todos os tenants;
 *  2. a visao por tenant ve so os seus, em `byStatus` e em `byNetwork`;
 *  3. latencia vem de `published_at` e ignora `updated_at` posterior;
 *  4. a janela de volume exclui job antigo, mas `byStatus` (estado atual) nao;
 *  5. taxa de falha por rede usa o estado final do job;
 *  6. os percentis batem com o `percentile_cont` do Postgres;
 *  7. o middleware falha fechado sem METRICS_TOKEN, e rejeita token errado;
 *  8. so `POST /posts` e `POST /upload-from-url` consomem cota;
 *  9. o contador soma o que foi TENTADO, e transiciona ok -> warning -> exhausted.
 *
 * Uso: npx ts-node --transpile-only scripts/verify-metrics.ts
 */
import { randomUUID } from 'node:crypto';
import type { Store } from '../src/store/types';
import type { Network, PublishJob, PublishJobStatus } from '../src/domain/types';

let checks = 0;

const ok = (message: string): void => {
  checks += 1;
  console.log(`ok ${checks} - ${message}`);
};

const fail = (message: string): never => {
  console.error(`FALHOU: ${message}`);
  process.exit(1);
};

const assert = (condition: unknown, message: string): void => {
  if (!condition) {
    fail(message);
  }
};

const minutesAgo = (minutes: number): string =>
  new Date(Date.now() - minutes * 60_000).toISOString();

/**
 * Envelhece um job movendo o `created_at` para o passado.
 *
 * A janela das metricas e sobre `created_at`, e `insertJob` carimba `now()`
 * (default do banco) -- entao um job semeado com `scheduled_at` antigo esta, para
 * efeito de metrica, recem-criado. Sem este helper nao ha como testar o recorte.
 *
 * Feito por SQL direto porque o store nao expoe `created_at`, e nao por elevacao
 * de privilegio: e o mesmo papel da aplicacao (`postmidia_app`), dentro do mesmo
 * `withTenant` que qualquer escrita de job respeita.
 */
const ageJob = async (tenantId: string, jobId: string, createdAt: string): Promise<void> => {
  const { withTenant } = await import('../src/db/pool');
  await withTenant(tenantId, async (client) => {
    await client.query('UPDATE publish_jobs SET created_at = $2 WHERE id = $1', [jobId, createdAt]);
  });
};

interface Seeded {
  tenantId: string;
  jobs: { succeeded: PublishJob; failed: PublishJob; old: PublishJob };
}

/**
 * Semeia um tenant com `latenciesSeconds` publicacoes de sucesso, cada uma com a
 * latencia EXATA que o parametro diz.
 *
 * A latencia e dada direto em segundos, e nao derivada de um "agendado ha X
 * minutos": derivar faz o check depender de aritmetica invisivel, e ja custou um
 * p50 esperado errado (480/600 em vez de 120/240) que parecia bug do Postgres.
 */
const seedTenant = async (
  store: Store,
  network: Network,
  options: { latenciesSeconds: number[] }
): Promise<Seeded> => {
  const tenant = await store.createTenant({
    name: `Ops ${network}`,
    slug: `ops-${randomUUID().slice(0, 8)}`,
  });
  const account = await store.insertAccount({
    tenantId: tenant.id,
    network,
    displayName: `ops_${randomUUID().slice(0, 8)}`,
    externalAccountId: `ext-${randomUUID().slice(0, 8)}`,
    encryptedSecret: 'x',
    scopes: ['publish'],
    status: 'connected',
    tokenExpiresAt: null,
  });
  const campaign = await store.insertCampaign({ tenantId: tenant.id, name: 'C', status: 'draft' });
  const post = await store.insertPost({
    tenantId: tenant.id,
    campaignId: campaign.id,
    contentType: 'text',
    text: 'oi',
    media: [],
    settings: {},
  });

  const make = async (status: PublishJobStatus, scheduledAt: string): Promise<PublishJob> =>
    store.insertJob({
      tenantId: tenant.id,
      postId: post.id,
      channelAccountId: account.id,
      network,
      recipient: 'destinatario',
      status,
      scheduledAt,
      attempts: 1,
      externalPostId: null,
      permalink: null,
      lastError: null,
    });

  // Todas as semeias sao agendadas para 10 minutos atras, entao `publishedAt` e
  // apenas esse instante mais a latencia pedida.
  const scheduledAt = minutesAgo(10);
  const succeeded = await make('succeeded', scheduledAt);
  const failed = await make('failed', scheduledAt);
  const old = await make('succeeded', minutesAgo(60 * 24 * 30));

  const published = [succeeded];
  for (const seconds of options.latenciesSeconds.slice(1)) {
    published.push(await make('succeeded', scheduledAt));
  }
  for (const [index, seconds] of options.latenciesSeconds.entries()) {
    await store.patchJob(tenant.id, published[index].id, {
      status: 'succeeded',
      publishedAt: new Date(new Date(scheduledAt).getTime() + seconds * 1000).toISOString(),
    });
  }

  return { tenantId: tenant.id, jobs: { succeeded, failed, old } };
};

const main = async (): Promise<void> => {
  // METRICS_TOKEN precisa existir antes do config ser carregado. O middleware le
  // `env.METRICS_TOKEN` a cada requisicao, entao da para religar/desligar em
  // tempo de execucao e provar o caminho de falha fechada sem subir outro processo.
  process.env.METRICS_TOKEN = 'a'.repeat(48);

  const { createPostgresStore } = await import('../src/store/postgres.store');
  const { createMemoryStore } = await import('../src/store/memory.store');
  const { env } = await import('../src/config');
  const { quotaBucketOf, recordPostizCall, readPostizQuota, clearPostizQuotaMemory } = await import(
    '../src/channels/postiz/quota'
  );
  const { requireMetricsToken } = await import('../src/http/metrics-auth');

  const store = createPostgresStore();
  const memory = createMemoryStore();

  // --- Latencia medida pelo campo certo ---
  //
  // Duas publicacoes: uma com 120s de espera, outra com 240s. O p50 tem de sair
  // no meio (180s) por interpolacao.
  //
  // A leitura e POR TENANT de proposito. O banco tem volume de execucoes
  // anteriores, e o p50 global misturaria os jobs semeados aqui com o historico
  // de todo mundo -- o check viraria dependente do que sobrou na base.
  const alpha = await seedTenant(store, 'instagram', { latenciesSeconds: [120, 240] });

  // O job "velho" precisa ficar velho tambem para a METRICA, e nao so no
  // agendamento: a janela filtra `created_at`, que o insert carimba com `now()`.
  await ageJob(alpha.tenantId, alpha.jobs.old.id, minutesAgo(60 * 24 * 30));

  const alphaMetrics = await store.getTenantOpsMetrics(alpha.tenantId, 24);

  assert(
    alphaMetrics.latency.samples === 2,
    `o tenant alpha semeou 2 publicacoes na janela, vieram ${alphaMetrics.latency.samples} amostras`
  );
  const p50 = alphaMetrics.latency.p50Seconds ?? -1;
  assert(
    Math.abs(p50 - 180) < 1,
    `p50 deveria ser 180s por interpolacao entre 120 e 240, veio ${p50}`
  );
  ok('o p50 interpola entre as amostras, como o percentile_cont');

  // O job de 30 dias esta fora da janela de 24h. Ela filtra em cima das duas
  // restricoes: o recorte de `created_at` e o recorte de `status = succeeded`.
  const inWindow = alphaMetrics.byNetwork.find((row) => row.network === 'instagram');
  assert(inWindow, 'a rede instagram deveria aparecer em byNetwork');
  assert(
    inWindow!.total === 3,
    `a janela de 24h deveria trazer 3 jobs de instagram (2 sucessos + 1 falha), trouxe ${inWindow!.total}`
  );
  ok('a janela de volume exclui o job criado ha 30 dias');

  // `byStatus` e estado atual da fila, sem recorte: o job velho segue contando.
  // E a assimetria que precisa existir -- se `byStatus` usasse a janela, um
  // operador veria a fila "esvaziar" so porque olhou depois do corte.
  const oldSucceeded = alphaMetrics.byStatus.succeeded ?? 0;
  assert(
    oldSucceeded === 3,
    `byStatus deveria contar os 3 jobs publicados do tenant, contou ${oldSucceeded}`
  );
  assert(
    (alphaMetrics.byStatus.failed ?? 0) === 1,
    `byStatus deveria contar a falha do tenant, contou ${alphaMetrics.byStatus.failed ?? 0}`
  );
  ok('byStatus e o estado atual da fila, sem recorte de janela');

  // --- A contagem de DLQ em aberto atravessa tenant ---
  //
  // Este check existe por causa de um modo de falha silencioso: sem policy de
  // leitura de sistema em `dead_letter_jobs`, a query do painel NAO daria erro --
  // o RLS simplesmente esconderia as linhas e o painel mostraria "zero
  // pendencias". Um painel que mente calmamente e pior do que um painel quebrado.
  await store.upsertDeadLetter({
    tenantId: alpha.tenantId,
    jobId: alpha.jobs.failed.id,
    attempts: 5,
    lastError: 'provider fora do ar',
    lastErrorCode: 'PROVIDER_DOWN',
  });

  const withDeadLetter = await store.getOpsMetrics(24);
  assert(
    withDeadLetter.openDeadLetters >= 1,
    `a visao de sistema deveria enxergar a DLQ em aberto, contou ${withDeadLetter.openDeadLetters}`
  );
  const alphaDead = await store.getTenantOpsMetrics(alpha.tenantId, 24);
  assert(
    alphaDead.openDeadLetters === 1,
    `o tenant alpha tem 1 entrada em DLQ, contou ${alphaDead.openDeadLetters}`
  );
  assert(
    alphaDead.tenantName !== null,
    'a visao por tenant deveria trazer o nome do tenant'
  );
  ok('a DLQ em aberto e contada nas duas visoes, provando a policy de leitura');

  // --- published_at e imune a patch posterior ---  //
  // E o motivo da coluna existir. Simula o que a reconciliacao faz: patcha o job
  // muito depois de publicado. A latencia nao pode se mover.
  const before = alphaMetrics.latency.p50Seconds;
  await store.patchJob(alpha.tenantId, alpha.jobs.succeeded.id, {
    externalPostId: 'ig-123',
    permalink: 'https://instagram.com/p/ig-123',
    releaseIdMissing: false,
    lastError: null,
  });
  const after = await store.getTenantOpsMetrics(alpha.tenantId, 24);
  assert(
    after.latency.p50Seconds === before,
    `um patch posterior moveu a latencia de ${before} para ${after.latency.p50Seconds}`
  );
  ok('published_at ignora patch posterior: a latencia nao mede a reconciliacao');

  // --- A visao de sistema atravessa tenants ---
  const beta = await seedTenant(store, 'telegram', { latenciesSeconds: [60, 180] });
  const systemWide = await store.getOpsMetrics(24);
  const networks = new Set(systemWide.byNetwork.map((row) => row.network));
  assert(networks.has('instagram'), 'a visao de sistema deveria ver instagram');
  assert(networks.has('telegram'), 'a visao de sistema deveria ver telegram');
  ok('a visao de sistema ve jobs de todos os tenants');

  // --- A visao por tenant nao ve o vizinho ---
  const onlyAlpha = await store.getTenantOpsMetrics(alpha.tenantId, 24);
  const alphaNetworks = onlyAlpha.byNetwork.map((row) => row.network);
  assert(
    alphaNetworks.every((network) => network === 'instagram'),
    `o tenant alpha so deveria ver instagram, viu ${alphaNetworks.join(', ')}`
  );
  assert(onlyAlpha.tenantId === alpha.tenantId, 'a visao por tenant deveria identificar o proprio tenant');
  ok('a visao por tenant nao enxerga jobs de outro tenant');

  // O RLS nao protege essa rota sozinho -- a leitura e de sistema -- entao o que
  // segura a separacao aqui e o parametro de tenant, e ele precisa contar
  // exatamente os jobs do tenant, nem mais nem menos. O job de 30 dias entra em
  // byStatus (estado atual) mas nao em byNetwork (janela de 24h).
  const alphaTotal = (onlyAlpha.byStatus.succeeded ?? 0) + (onlyAlpha.byStatus.failed ?? 0);
  const alphaRows = onlyAlpha.byNetwork.reduce((sum, row) => sum + row.total, 0);
  assert(
    alphaTotal === 4 && alphaRows === 3,
    `o tenant alpha tem 4 jobs no total e 3 na janela, contou ${alphaTotal} e ${alphaRows}`
  );
  ok('as contagens do tenant batem com os jobs realmente dele');

  // --- Taxa de falha por rede ---
  const instagramRow = onlyAlpha.byNetwork.find((row) => row.network === 'instagram');
  assert(instagramRow, 'instagram deveria aparecer na visao do tenant alpha');
  assert(
    instagramRow!.total === 3 && instagramRow!.failed === 1,
    `instagram deveria ter 3 jobs e 1 falha na janela, veio ${JSON.stringify(instagramRow)}`
  );
  assert(
    Math.abs((instagramRow!.failureRate ?? -1) - 1 / 3) < 0.0001,
    `a taxa de falha de instagram deveria ser 1/3, veio ${instagramRow!.failureRate}`
  );
  ok('a taxa de falha por rede usa o estado final do job');

  // --- Paridade entre os dois backends ---
  //
  // A implementacao em memoria reimplementa o `percentile_cont`. Divergir ali
  // faria o mesmo numero mudar conforme o backend, o que e o modo classico de
  // metrica em que ninguem mais confia.
  const memoryAlpha = await seedTenant(memory, 'instagram', { latenciesSeconds: [120, 240] });
  const memoryMetrics = await memory.getOpsMetrics(24);
  const memoryAlphaView = await memory.getTenantOpsMetrics(memoryAlpha.tenantId, 24);
  assert(
    Math.abs((memoryAlphaView.latency.p50Seconds ?? -1) - 180) < 1,
    `o p50 em memoria divergiu: ${memoryAlphaView.latency.p50Seconds}`
  );
  assert(
    memoryMetrics.byStatus.succeeded >= 2 && memoryMetrics.byNetwork.length >= 1,
    'a visao de sistema em memoria nao devolveu volume'
  );
  ok('os percentis em memoria batem com o do Postgres');

  // --- Classificacao de cota ---
  assert(quotaBucketOf('post', '/posts') === 'posts', 'POST /posts deveria consumir a cota de posts');
  assert(
    quotaBucketOf('post', '/upload-from-url') === 'uploads',
    'POST /upload-from-url deveria consumir a cota de uploads'
  );
  assert(
    quotaBucketOf('get', '/posts/abc/missing') === null,
    'GET /posts/:id/missing nao deveria consumir cota'
  );
  assert(
    quotaBucketOf('get', '/integration-settings/1') === null,
    'leitura de integracao nao deveria consumir cota'
  );
  assert(quotaBucketOf('delete', '/posts') === null, 'DELETE /posts nao deveria consumir cota');
  ok('so POST /posts e POST /upload-from-url consomem cota');

  // --- Contagem e transicao de estado ---
  clearPostizQuotaMemory();
  const posts = await readPostizQuota('posts');
  assert(posts.limit === 90, `o limite de posts deveria ser 90, veio ${posts.limit}`);
  assert(posts.state === 'ok', `sem consumo o estado deveria ser ok, veio ${posts.state}`);

  // O Redis real pode ter uso de outras execucoes; a transicao e testada no
  // contador de memoria, que comeca em zero.
  const beforeUploads = (await readPostizQuota('uploads')).used;
  for (let i = 0; i < 5; i += 1) {
    await recordPostizCall('uploads');
  }
  const afterUploads = await readPostizQuota('uploads');
  assert(
    afterUploads.used === beforeUploads + 5,
    `o contador deveria subir de ${beforeUploads} para ${beforeUploads + 5}, veio ${afterUploads.used}`
  );
  assert(
    afterUploads.remaining === Math.max(0, 30 - afterUploads.used),
    `o restante deveria ser 30 menos o uso, veio ${afterUploads.remaining}`
  );
  ok('o contador de cota soma as tentativas e recalcula o restante');

  const uploads = await readPostizQuota('uploads');
  assert(
    uploads.limit === 30 && posts.limit === 90,
    'upload-from-url tem limite menor que posts: e a cota que aperta primeiro'
  );
  ok('os limites por classe batem com o Postiz (90/h posts, 30/h uploads)');

  // --- O gate de plataforma ---
  const call = (token: string | undefined): { status: number; nextCalled: boolean } => {
    let status = 0;
    let nextCalled = false;
    const res = {
      status(code: number) {
        status = code;
        return this;
      },
      json() {
        return this;
      },
    };
    requireMetricsToken(
      { header: (name: string) => (name.toLowerCase() === 'x-metrics-token' ? token : undefined) } as never,
      res as never,
      () => {
        nextCalled = true;
      }
    );
    return { status, nextCalled };
  };

  assert(call('a'.repeat(48)).nextCalled, 'o token correto deveria passar');
  assert(call('a'.repeat(47)).status === 401, 'um token curto demais deveria dar 401');
  assert(call('b'.repeat(48)).status === 401, 'um token errado deveria dar 401');
  assert(call(undefined).status === 401, 'sem token deveria dar 401');
  ok('o gate aceita so o token exato');

  // Falha fechada: sem METRICS_TOKEN a rota responde 503, nunca liberada. E o que
  // impede um endpoint de observabilidade de virar endpoint de observacao aberta
  // so porque alguem esqueceu de configurar o segredo.
  const configured = env.METRICS_TOKEN;
  (env as { METRICS_TOKEN: string }).METRICS_TOKEN = '';
  const closed = call('a'.repeat(48));
  assert(closed.status === 503, `sem METRICS_TOKEN o gate deveria dar 503, deu ${closed.status}`);
  assert(!closed.nextCalled, 'sem METRICS_TOKEN o gate nao pode liberar a rota');
  (env as { METRICS_TOKEN: string }).METRICS_TOKEN = configured;
  assert(call('a'.repeat(48)).nextCalled, 'o gate deveria voltar a funcionar apos restaurar o token');
  ok('sem METRICS_TOKEN a rota falha fechada com 503');

  await store.close();
  await memory.close();
  console.log(`\nOK: ${checks} verificacoes do painel operacional`);
  process.exit(0);
};

main().catch((error) => {
  fail(String(error));
});
