import type { PublishJob } from '../domain/types';
import type { PublishJobHandler, PublishQueue } from './publish.queue';

export const createMemoryQueue = (): PublishQueue => {
  const timers = new Map<string, NodeJS.Timeout>();
  let handler: PublishJobHandler | null = null;
  let closed = false;

  return {
    // O `dispatchKey` do Redis nao tem equivalente aqui: a fila em memoria
    // cancela o timer anterior pelo job.id antes de reagendar, entao nao existe
    // a colisao de id que o BullMQ teria.
    async enqueue(job: PublishJob, delayMs: number): Promise<void> {
      if (closed) {
        throw new Error('Fila encerrada');
      }
      this.cancel(job.id);
      const run = async (): Promise<void> => {
        timers.delete(job.id);
        if (!handler || closed) {
          return;
        }
        try {
          await handler(job);
        } catch (error) {
          console.error(`[fila] job ${job.id} lancou excecao nao tratada`, error);
        }
      };
      if (delayMs <= 0) {
        void run();
        return;
      }
      timers.set(
        job.id,
        setTimeout(() => {
          void run();
        }, delayMs)
      );
    },

    start(next: PublishJobHandler): void {
      handler = next;
    },

    cancel(jobId: string): void {
      const timer = timers.get(jobId);
      if (timer) {
        clearTimeout(timer);
        timers.delete(jobId);
      }
    },

    async reschedule(job: PublishJob, delayMs: number): Promise<void> {
      if (closed) {
        throw new Error('Fila encerrada');
      }
      // `enqueue` ja cancela o timer anterior pelo job.id antes de reagendar,
      // entao reaproveitar ele mantem as duas implementacoes com o mesmo
      // comportamento em memoria.
      await this.enqueue(job, delayMs);
    },

    async close(): Promise<void> {
      closed = true;
      for (const timer of timers.values()) {
        clearTimeout(timer);
      }
      timers.clear();
    },
  };
};
