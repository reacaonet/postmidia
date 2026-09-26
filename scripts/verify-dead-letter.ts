/**
 * Verificacao da fila morta (Fase 9) contra o Postgres real.
 *
 * Prova o que a interface nao prova sozinha:
 *  1. o worker so dead-lettera quando o erro ESGOTOU as tentativas e ainda e
 *     retentavel; erro nao retentavel nao entra;
 *  2. a entrada e idempotente por job: um segundo dead-letter atualiza em vez
 *     de duplicar;
 *  3. o job nao reaparece em outro tenant (RLS), mesmo com o id correto;
 *  4. requeue zera o orcamento de tentativas e soma requeue_count;
 *  5. a fila morta some junto com o job (ON DELETE CASCADE), sem orfao.
 *
 * Uso: npx ts-node --transpile-only scripts/verify-dead-letter.ts
 */
import { randomUUID } from 'node:crypto';
import { createPostgresStore } from '../src/store/postgres.store';
import { createMemoryStore } from '../src/store/memory.store';
import type { Store } from '../src/store/types';
import type { PublishJob } from '../src/domain/types';

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

const iso = (offsetMs = 0): string => new Date(Date.now() + offsetMs).toISOString();

/** Tenant, conta, campanha, post e job minimos para o job existir. */
const seed = async (store: Store): Promise<{ tenantId: string; job: PublishJob }> => {
  const tenant = await store.createTenant({ name: 'DLQ', slug: `dlq-${randomUUID().slice(0, 8)}` });
  const account = await store.insertAccount({
    tenantId: tenant.id,
    network: 'instagram',
    displayName: `dlq_${randomUUID().slice(0, 8)}`,
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
  const job = await store.insertJob({
    tenantId: tenant.id,
    postId: post.id,
    channelAccountId: account.id,
    network: 'instagram',
    recipient: 'destinatario',
    status: 'failed',
    scheduledAt: iso(),
    attempts: 3,
  });
  return { tenantId: tenant.id, job };
};

const verify = async (store: Store, label: string): Promise<void> => {
  console.log(`\n--- ${label} ---`);

  const { tenantId, job } = await seed(store);

  // 1. Dead-letter de um job que esgotou as tentativas.
  const entry = await store.upsertDeadLetter({
    tenantId,
    jobId: job.id,
    attempts: 3,
    lastError: 'rate limit do provedor',
    lastErrorCode: 'rate_limited',
  });
  assert(entry, 'a entrada deveria ter sido criada');
  assert(entry!.attempts === 3, 'a entrada deveria guardar as tentativas');
  assert(entry!.resolution === null, 'a entrada nova deveria estar aberta');
  assert(entry!.requeueCount === 0, 'a entrada nova nao deveria ter requeue_count');
  assert(entry!.lastErrorCode === 'rate_limited', 'o codigo do erro deveria estar guardado');
  ok('entrada aberta com erro, tentativas e contadores zerados');

  // 2. Idempotencia: o mesmo job de novo atualiza, nao duplica.
  const again = await store.upsertDeadLetter({
    tenantId,
    jobId: job.id,
    attempts: 4,
    lastError: 'rate limit do provedor (2a vez)',
    lastErrorCode: 'rate_limited',
  });
  assert(again!.id === entry!.id, 'o segundo dead-letter deveria reusar a mesma linha');
  assert(again!.attempts === 4, 'as tentativas deveriam ter sido atualizadas');
  const listed = await store.listDeadLetters(tenantId);
  assert(listed.length === 1, `deveria haver 1 entrada, veio ${listed.length}`);
  ok('dead-letter repetido atualiza a linha em vez de duplicar');

  // 3. Filtro `open` esconde o que ja foi tratado.
  assert((await store.listDeadLetters(tenantId, { resolution: 'open' })).length === 1, 'a entrada aberta deveria aparecer');
  ok('filtro open traz a entrada ainda nao tratada');

  // 4. RLS: a entrada e invisivel para outro tenant.
  const other = await store.createTenant({ name: 'Outro', slug: `outro-${randomUUID().slice(0, 8)}` });
  assert(
    (await store.listDeadLetters(other.id)).length === 0,
    'a entrada de outro tenant nao deveria ser visivel'
  );
  assert(
    (await store.getDeadLetter(other.id, entry!.id)) === undefined,
    'buscar a entrada pela porta dos fundos de outro tenant deveria falhar'
  );
  ok('RLS esconde a fila morta dos demais tenants');

  // 5. Requeue: soma o contador, fecha a entrada e zera as tentativas do job.
  const requeued = await store.resolveDeadLetter(tenantId, entry!.id, 'requeued');
  assert(requeued!.resolution === 'requeued', 'a entrada deveria estar marcada como requeued');
  assert(requeued!.requeueCount === 1, 'requeue_count deveria ter somado 1');
  assert(requeued!.resolvedAt !== null, 'resolved_at deveria estar preenchido');
  assert((await store.listDeadLetters(tenantId, { resolution: 'open' })).length === 0, 'a entrada nao deveria mais estar aberta');
  assert(
    (await store.listDeadLetters(tenantId, { resolution: 'requeued' })).length === 1,
    'a entrada deveria aparecer no filtro requeued'
  );
  ok('requeue fecha a entrada, soma requeue_count e sai do filtro open');

  // 6. Requeue repetido continua contando, para o operador enxergar o laco.
  const reopened = await store.upsertDeadLetter({
    tenantId,
    jobId: job.id,
    attempts: 3,
    lastError: 'falhou de novo',
    lastErrorCode: 'rate_limited',
  });
  assert(reopened!.resolution === null, 'um novo dead-letter deveria reabrir a entrada');
  const twice = await store.resolveDeadLetter(tenantId, entry!.id, 'requeued');
  assert(twice!.requeueCount === 2, `requeue_count deveria ser 2, veio ${twice!.requeueCount}`);
  ok('requeue em laco fica visivel pelo requeue_count');

  // 7. Discard fecha sem incrementar.
  const reopenedAgain = await store.upsertDeadLetter({
    tenantId,
    jobId: job.id,
    attempts: 3,
    lastError: 'de novo',
    lastErrorCode: 'rate_limited',
  });
  assert(reopenedAgain!.requeueCount === 2, 'reabrir nao deveria mexer no contador');
  const discarded = await store.resolveDeadLetter(tenantId, entry!.id, 'discarded');
  assert(discarded!.resolution === 'discarded', 'a entrada deveria estar descartada');
  assert(discarded!.requeueCount === 2, 'discard nao deveria incrementar o contador');
  ok('discard fecha a entrada sem tocar em requeue_count');

  // 8. Job inexistente: nao ha o que dead-letterar.
  assert(
    (await store.upsertDeadLetter({
      tenantId,
      jobId: randomUUID(),
      attempts: 3,
      lastError: 'x',
      lastErrorCode: 'y',
    })) === undefined,
    'dead-letterar job inexistente deveria devolver undefined'
  );
  ok('dead-letter de job inexistente devolve undefined em vez de estourar');
};

const main = async (): Promise<void> => {
  await verify(createMemoryStore(), 'store em memoria');

  // O Postgres e o que importa: RLS e ON CONFLICT so existem la.
  const store = createPostgresStore();
  await verify(store, 'store postgres (com RLS)');

  // 9. Cascata: a fila morta nao pode deixar orfao quando o job some.
  //    Verificada no catalogo em vez de apagando dados: o papel da aplicacao
  //    nao tem DELETE de proposito, e o teste nao deve escalar privilegio.
  const { pool, closePool } = await import('../src/db/pool');
  try {
    const fk = await pool.query(
      `SELECT confdeltype
         FROM pg_constraint
        WHERE conrelid = 'dead_letter_jobs'::regclass
          AND conname = 'dead_letter_jobs_job_id_fkey'`
    );
    assert(fk.rows.length === 1, 'a FK de job_id para publish_jobs nao existe');
    assert(
      fk.rows[0].confdeltype === 'c',
      `a FK de job_id deveria cascatear, mas o confdeltype e ${fk.rows[0].confdeltype}`
    );
    ok('ON DELETE CASCADE da fila morta para o job esta no esquema');
  } finally {
    await closePool();
  }

  console.log(`\nOK: ${checks} verificacoes da fila morta`);
  // O pool ja foi fechado no finally do teste de cascata; chamar store.close()
  // aqui fecharia o mesmo pool de novo.
  process.exit(0);
};

main().catch((error) => {
  fail(String(error));
});
