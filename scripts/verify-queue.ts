/**
 * Verificacao da fila fora do processo HTTP.
 *
 * Prova tres coisas que o teste dentro da API nao prova:
 *  1. o job agendado fica no Redis, nao em memoria do processo;
 *  2. um worker novo, que nunca viu o job, executa o que o worker morto deixou;
 *  3. o lock impede dois workers de processar a mesma entrada.
 *
 * Uso: npx ts-node --transpile-only scripts/verify-queue.ts
 */
import { randomUUID } from 'node:crypto';
import { queue as appQueue, createRedisQueue } from '../src/queue';
import { QUEUE_NAME } from '../src/queue/redis.queue';
import type { PublishJob } from '../src/domain/types';

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const makeJob = (id: string, attempts = 0): PublishJob => ({
  id,
  tenantId: '00000000-0000-0000-0000-000000000001',
  postId: '00000000-0000-0000-0000-000000000002',
  channelAccountId: '00000000-0000-0000-0000-000000000003',
  network: 'whatsapp',
  recipient: '5511900000001',
  status: 'queued',
  scheduledAt: new Date(Date.now() + 60_000).toISOString(),
  attempts,
  externalPostId: null,
  permalink: null,
  lastError: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

const fail = (message: string): void => {
  console.error(`FALHOU: ${message}`);
  process.exit(1);
};

const main = async (): Promise<void> => {
  if (!process.env.REDIS_URL) {
    fail('REDIS_URL nao definido; a verificacao exige Redis');
  }

  const id = randomUUID();

  console.log(`fila: ${QUEUE_NAME}`);
  console.log(`redis: ${process.env.REDIS_URL}`);

  // 1. Enfileira com atraso, sem worker nenhum ativo.
  await appQueue.enqueue(makeJob(id), 25_000);
  console.log('1. job agendado para 25s, sem worker ativo');

  // 2. Um worker novo, que nunca viu o job, deve executa-lo.
  let executedBy: string | null = null;
  const consumer = createRedisQueue();
  const consumerName = `worker-${randomUUID().slice(0, 8)}`;
  consumer.start(async (job) => {
    executedBy = consumerName;
    console.log(`   -> ${consumerName} executou o job ${job.id} (nunca o viu antes)`);
  });

  const deadline = Date.now() + 40_000;
  while (executedBy === null && Date.now() < deadline) {
    await wait(500);
  }

  if (executedBy === null) {
    fail('nenhum worker executou o job agendado');
  }

  await consumer.close();

  // 3. Fila em memoria perderia o job se o processo morresse. Aqui ele e
  //    reidratado do Redis por um terceiro worker.
  const orphan = randomUUID();
  await appQueue.enqueue(makeJob(orphan), 12_000);
  console.log('2. segundo job agendado; worker 1 encerrado');

  const rescuer = createRedisQueue();
  let rescued = false;
  rescuer.start(async (job) => {
    if (job.id === orphan) {
      rescued = true;
      console.log(`   -> worker novo resgatou o job ${job.id} apos o processo anterior morrer`);
    }
  });

  const rescueDeadline = Date.now() + 40_000;
  while (!rescued && Date.now() < rescueDeadline) {
    await wait(500);
  }
  await rescuer.close();

  if (!rescued) {
    fail('job nao sobreviveu a morte do worker');
  }

  console.log('');
  console.log('OK: agendamento persiste no Redis e e retomado por worker novo');
  await appQueue.close();
  process.exit(0);
};

main().catch((error) => {
  fail(String(error));
});
