import { env } from '../config';
import { createMemoryQueue } from './memory.queue';
import { createRedisQueue } from './redis.queue';
import type { PublishQueue } from './publish.queue';

export const queue: PublishQueue = env.REDIS_URL ? createRedisQueue() : createMemoryQueue();

if (env.REDIS_URL) {
  console.log('[fila] backend: bullmq/redis');
} else {
  console.log('[fila] backend: memoria (defina REDIS_URL para sobreviver a restart e escalar worker)');
}

export type { PublishQueue, PublishJobHandler } from './publish.queue';
export { createMemoryQueue } from './memory.queue';
export { createRedisQueue, QUEUE_NAME } from './redis.queue';
