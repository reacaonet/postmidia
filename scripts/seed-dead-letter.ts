/**
 * Semeia uma entrada de fila morta para o tenant do E2E.
 *
 * Existe porque a rota de requeue so faz sentido com um job que esgotou
 * tentativas, e esperar o worker real esvaziar o backoff nao cabe no tempo de
 * um E2E. Aqui o estado e preparado direto no store -- que e justamente o
 * estado autoritativo -- e o resto do teste prova a camada HTTP em cima dele.
 *
 * O worker nao esta rodando durante o seeding, entao o job criado nao e
 * executado as tudo: ele fica queued, que e o estado que o requeue espera
 * reencontrar.
 *
 * O id da entrada vai para um ARQUIVO, nao para o stdout. O store e o pool
 * escrevem banners de inicializacao em `console.log`, ou seja, no mesmo stdout:
 * ler o id de `$(...)` devolveria tres linhas e construiria uma URL quebrada
 * silenciosamente -- o E2E falharia longe da causa.
 *
 * Uso: npx ts-node --transpile-only scripts/seed-dead-letter.ts <slug> <jobId> <outFile> [--succeeded]
 *
 * `--succeeded` marca o job como publicado logo depois de dead-letterar, o que
 * reproduz a corrida que a rota precisa barrar: a triagem mostra uma entrada
 * aberta, mas o job foi concluido antes do clique em "requeue". Fica aqui em
 * vez de num script separado para nao pagar dois startups do ts-node no E2E.
 */
import { writeFileSync } from 'node:fs';
import { createPostgresStore } from '../src/store/postgres.store';

const fail = (message: string): never => {
  console.error(`FALHOU: ${message}`);
  process.exit(1);
};

const main = async (): Promise<void> => {
  const [, , slug, jobId, outFile, ...flags] = process.argv;
  if (!slug || !jobId || !outFile) {
    fail('uso: seed-dead-letter.ts <slug> <jobId> <outFile> [--succeeded]');
  }
  const markSucceeded = flags.includes('--succeeded');

  const store = createPostgresStore();

  const tenant = await store.getTenantBySlug(slug);
  if (!tenant) {
    fail(`tenant ${slug} nao encontrado`);
  }

  const job = await store.getJob(tenant.id, jobId);
  if (!job) {
    fail(`job ${jobId} nao encontrado no tenant ${slug}`);
  }

  // Deixa o job como esgotado: e o estado que o worker produz antes de
  // dead-letterar, e o que o requeue precisa reencontrar.
  await store.patchJob(tenant.id, job.id, {
    status: 'failed',
    attempts: 3,
    lastError: 'rate_limited: seeding do E2E',
  });

  const entry = await store.upsertDeadLetter({
    tenantId: tenant.id,
    jobId: job.id,
    attempts: 3,
    lastError: 'seeding do E2E',
    lastErrorCode: 'rate_limited',
  });
  if (!entry) {
    fail('upsertDeadLetter nao devolveu entrada');
  }

  if (markSucceeded) {
    const done = await store.patchJob(tenant.id, job.id, {
      status: 'succeeded',
      externalPostId: 'post-fake-1',
    });
    if (!done || done.status !== 'succeeded') {
      fail('nao foi possivel marcar o job como sucesso');
    }
  }

  writeFileSync(outFile, entry.id, 'utf8');

  await store.close();
  process.exit(0);
};

main().catch((error) => {
  fail(String(error));
});
