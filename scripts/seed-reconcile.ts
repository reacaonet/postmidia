/**
 * Semeia um job publicado SEM o id do provedor, para o tenant do E2E.
 *
 * Existe pelo mesmo motivo do seed-dead-letter.ts: o estado que a rota de
 * reconciliacao precisa encontrar -- `succeeded` + `releaseIdMissing` + um id
 * interno do Postiz -- so acontece quando um provedor real devolve
 * `releaseId: 'missing'`, o que nao da para provoking no tempo de um E2E. Aqui o
 * estado e preparado direto no store, que e o estado autoritativo, e o resto do
 * teste prova a camada HTTP em cima dele.
 *
 * O `externalPostId` semeado NAO existe no Postiz de verdade. E de proposito: a
 * rota deve propagar a falha do Postiz como 502, em vez de fingir que
 * reconciliou. Um id Postiz sintetico que a API aceitasse daria um falso
 * "reconciliado" para um post que nao foi publicado.
 *
 * O job semeado NAO e limpo. Um DELETE cascatearia tambem o job da secao da fila
 * morta, que o E2E ainda consulta depois deste seeding.
 *
 * O id vai para um ARQUIVO, nunca para o stdout: o store e o pool escrevem
 * banners de inicializacao em `console.log` e poluiriam a captura.
 *
 * `--unmarked` faz o oposto: marca o job como publicado COM o id do provedor e
 * sem o marcador. Serve ao segundo ramo do 409 da rota (job publicado que ja
 * tem o que foi reconciliado) e nao custa um terceiro startup do ts-node no E2E.
 *
 * Uso: npx ts-node --transpile-only scripts/seed-reconcile.ts <slug> <jobId> <outFile> [--unmarked]
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
    fail('uso: seed-reconcile.ts <slug> <jobId> <outFile> [--unmarked]');
  }
  const unmarked = flags.includes('--unmarked');

  const store = createPostgresStore();

  const tenant = await store.getTenantBySlug(slug);
  if (!tenant) {
    fail(`tenant ${slug} nao encontrado`);
  }

  const job = await store.getJob(tenant.id, jobId);
  if (!job) {
    fail(`job ${jobId} nao encontrado no tenant ${slug}`);
  }

  // Exatamente o patch que o worker faz ao concluir uma publicacao cujo
  // provedor ainda nao devolveu o id -- ou, com --unmarked, o de uma
  // publicacao que ja recebeu o id.
  const suffix = job.id.slice(0, 8);
  const seeded = await store.patchJob(tenant.id, job.id, {
    status: 'succeeded',
    attempts: 1,
    externalPostId: unmarked ? `ig-real-${suffix}` : `postiz-sem-id-${suffix}`,
    permalink: unmarked ? `https://instagram.com/p/ig-real-${suffix}` : null,
    releaseIdMissing: !unmarked,
    lastError: unmarked ? null : 'publicado sem id do provedor; reconciliar via releaseIdMissing',
  });

  if (!seeded) {
    fail('nao foi possivel marcar o job semeado');
  }
  if (seeded.status !== 'succeeded') {
    fail(`o job deveria estar succeeded, esta ${seeded.status}`);
  }
  // Reler e conferir, em vez de confiar no objeto devolvido pelo patch: uma
  // coluna nova ja passou por aqui sem persistir, por um motivo diferente.
  if (seeded.releaseIdMissing === unmarked) {
    fail(`releaseIdMissing deveria ser ${!unmarked}, veio ${seeded.releaseIdMissing}`);
  }

  writeFileSync(outFile, job.id, 'utf8');

  await store.close();
  process.exit(0);
};

main().catch((error) => {
  fail(String(error));
});
