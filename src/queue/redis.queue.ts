import { Queue, Worker, type JobsOptions } from 'bullmq';
import IORedis from 'ioredis';
import { env } from '../config';
import type { PublishJob } from '../domain/types';
import type { PublishJobHandler, PublishQueue } from './publish.queue';

// BullMQ recusa ':' no nome da fila.
export const QUEUE_NAME = 'postmidia-publish';

const parseRedisUrl = (url: string): { host: string; port: number; password?: string } => {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: Number(parsed.port || 6379),
    password: parsed.password || undefined,
  };
};

export const createConnection = (): IORedis => {
  const { host, port, password } = parseRedisUrl(env.REDIS_URL);
  return new IORedis({
    host,
    port,
    // "localhost" resolve para ::1 primeiro no Node 18+, e o mapeamento de
    // porta do Docker so escuta em IPv4. Sem isto, a conexao falha com
    // ECONNREFUSED em ::1 mesmo com o container no ar.
    family: 4,
    ...(password ? { password } : {}),
    maxRetriesPerRequest: null,
  });
};

/**
 * O id da entrada inclui a tentativa. Se usassemos so `job.id`, o re-agendamento
 * do worker seria um no-op silencioso: o BullMQ ignora `add` com id ja existente,
 * e o retry nunca voltaria a rodar.
 */
const entryId = (job: PublishJob): string => `${job.id}#${job.attempts}`;

export const createRedisQueue = (): PublishQueue => {
  const connection = createConnection();
  const queue = new Queue<PublishJob>(QUEUE_NAME, { connection });
  let worker: Worker<PublishJob> | null = null;
  let closed = false;

  const baseOptions: JobsOptions = {
    removeOnComplete: 1000,
    removeOnFail: 5000,
    attempts: 1,
  };

  return {
    async enqueue(job: PublishJob, delayMs: number): Promise<void> {
      if (closed) {
        throw new Error('Fila encerrada');
      }

      const options: JobsOptions =
        delayMs > 0 ? { ...baseOptions, delay: delayMs } : { ...baseOptions };

      await queue.add('publish', job, { ...options, jobId: entryId(job) });
    },

    start(next: PublishJobHandler): void {
      if (worker) {
        return;
      }

      worker = new Worker<PublishJob>(
        QUEUE_NAME,
        async (bullJob) => {
          const job = bullJob.data;
          try {
            await next(job);
          } catch (error) {
            // A excecao ja foi tratada e persistida por handleJob; nao deixe
            // o BullMQ marcar como falha que dispara retry atras do nosso.
            console.error(`[fila] job ${job.id} lancou excecao nao tratada`, error);
          }
        },
        {
          connection,
          // Um job so pode rodar em um worker por vez. O lock e do BullMQ e
          // impede que dois processos peguem o mesmo job, que era o furo do
          // agendamento em memoria.
          concurrency: env.PUBLISH_WORKER_CONCURRENCY,
          lockDuration: 120_000,
        }
      );

      worker.on('failed', (bullJob, error) => {
        console.error(`[fila] entrada ${bullJob?.id ?? '?'} falhou: ${error.message}`);
      });

      console.log(
        `[fila] worker BullMQ iniciado (concurrency=${env.PUBLISH_WORKER_CONCURRENCY}) em ${env.REDIS_URL}`
      );
    },

    cancel(jobId: string): void {
      void queue
        .getJobs(['waiting', 'delayed'])
        .then(async (jobs) => {
          for (const candidate of jobs) {
            if (candidate.data.id === jobId && candidate.id) {
              try {
                await candidate.remove();
              } catch {
                // Job ja foi puxado pelo worker; nao ha o que remover.
              }
            }
          }
        })
        .catch((error) => {
          console.error(`[fila] falha ao cancelar ${jobId}: ${(error as Error).message}`);
        });
    },

    async close(): Promise<void> {
      closed = true;
      if (worker) {
        await worker.close();
        worker = null;
      }
      await queue.close();
      await connection.quit();
    },
  };
};
