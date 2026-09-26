import type { PublishJob } from '../domain/types';

export type PublishJobHandler = (job: PublishJob) => Promise<void>;

export interface PublishQueue {
  enqueue(job: PublishJob, delayMs: number, dispatchKey?: string): Promise<void>;
  start(handler: PublishJobHandler): void;
  cancel(jobId: string): void;
  close(): Promise<void>;
}
