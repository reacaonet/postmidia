import { env } from '../config';
import { createConnection } from '../queue/redis.queue';

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  limit: number;
  retryAfterSeconds: number;
}

interface Bucket {
  hits: number[];
}

const memoryBuckets = new Map<string, Bucket>();

let redis: ReturnType<typeof createConnection> | null = null;

const getRedis = (): ReturnType<typeof createConnection> | null => {
  if (!env.REDIS_URL) {
    return null;
  }
  redis ??= createConnection();
  return redis;
};

/**
 * Janela deslizante. Com REDIS_URL a janela e compartilhada entre processos e
 * sobrevive a restart; sem ele, cai para memoria (apenas instancia unica).
 *
 * O script Lua faz o recorte e a insercao em uma operacao atomica: sem ele,
 * dois requests concorrentes leriao a mesma lista e o limite estouraria.
 */
const SLIDING_WINDOW_LUA = `
local key = KEYS[1]
local limit = tonumber(ARGV[1])
local window_ms = tonumber(ARGV[2])
local now_ms = tonumber(ARGV[3])

redis.call('ZREMRANGEBYSCORE', key, 0, now_ms - window_ms)
local hits = redis.call('ZCARD', key)

if hits >= limit then
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local retry_ms = window_ms
  if oldest[2] then
    retry_ms = (tonumber(oldest[2]) + window_ms) - now_ms
  end
  return { 0, 0, math.ceil(math.max(retry_ms, 1) / 1000) }
end

redis.call('ZADD', key, now_ms, now_ms .. ':' .. math.random())
redis.call('PEXPIRE', key, window_ms)
return { 1, limit - hits - 1, 0 }
`;

export const rateLimit = (
  key: string,
  limit = env.RATE_LIMIT_MAX_REQUESTS,
  windowMs = env.RATE_LIMIT_WINDOW_MS
): Promise<RateLimitResult> => {
  const client = getRedis();

  if (client) {
    return client
      .eval(SLIDING_WINDOW_LUA, 1, `ratelimit:${key}`, String(limit), String(windowMs), String(Date.now()))
      .then((raw) => {
        const [allowed, remaining, retryAfterSeconds] = raw as [number, number, number];
        return {
          allowed: allowed === 1,
          remaining: Number(remaining),
          limit,
          retryAfterSeconds: Number(retryAfterSeconds),
        };
      })
      .catch((error) => {
        // Falha do Redis nao pode derrubar a API inteira; degrada para memoria.
        console.error(`[ratelimit] Redis indisponivel, usando memoria: ${(error as Error).message}`);
        return rateLimitMemory(key, limit, windowMs);
      });
  }

  return Promise.resolve(rateLimitMemory(key, limit, windowMs));
};

const rateLimitMemory = (key: string, limit: number, windowMs: number): RateLimitResult => {
  const now = Date.now();
  const windowStart = now - windowMs;

  const bucket = memoryBuckets.get(key) ?? { hits: [] };
  bucket.hits = bucket.hits.filter((at) => at > windowStart);

  if (bucket.hits.length >= limit) {
    memoryBuckets.set(key, bucket);
    return {
      allowed: false,
      remaining: 0,
      limit,
      retryAfterSeconds: Math.max(1, Math.ceil((bucket.hits[0] + windowMs - now) / 1000)),
    };
  }

  bucket.hits.push(now);
  memoryBuckets.set(key, bucket);

  return { allowed: true, remaining: limit - bucket.hits.length, limit, retryAfterSeconds: 0 };
};

export const rateLimitByIp = (ip: string, limit: number, windowMs: number): Promise<RateLimitResult> =>
  rateLimit(`ip:${ip}`, limit, windowMs);

export const rateLimitByTenant = (
  tenantId: string,
  limit: number,
  windowMs: number
): Promise<RateLimitResult> => rateLimit(`tenant:${tenantId}`, limit, windowMs);

export const clearRateLimits = (): void => {
  memoryBuckets.clear();
};
