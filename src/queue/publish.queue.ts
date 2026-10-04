import type { PublishJob } from '../domain/types';

export type PublishJobHandler = (job: PublishJob) => Promise<void>;

export interface PublishQueue {
  enqueue(job: PublishJob, delayMs: number, dispatchKey?: string): Promise<void>;
  start(handler: PublishJobHandler): void;
  cancel(jobId: string): void;
  /**
   * Troca o horario de um job que ainda nao rodou.
   *
   * Existe em vez de `cancel` seguido de `enqueue` porque as duas operacoes nao
   * se cancelam: no BullMQ o `cancel` e assincrono e a busca das entradas pode
   * terminar depois do `add`,_removendo a entrada recem-criada em vez da
   * antiga. Agendar de novo o mesmo job tambem esbarraria no id repetido
   * (`<id>#<attempts>`), que o BullMQ ignora em silencio. Aqui a remocao e o
   * `add` sao um passo so, com um `dispatchKey` novo.
   */
  reschedule(job: PublishJob, delayMs: number): Promise<void>;
  close(): Promise<void>;
}
