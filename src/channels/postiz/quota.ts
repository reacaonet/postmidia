/**
 * Contabilidade de cota do Postiz.
 *
 * O Postiz limita por ORGANIZACAO, nao por conta e nao por API key: duas
 * chaves da mesma instancia dividem os mesmos 90/h de `POST /posts`. Logo o
 * contador e global, e nao por tenant. Expor "quanto o seu tenant gastou" seria
 * um numero sem significado: o upload de um tenant queima a cota de todo mundo.
 *
 * **Conta tentativas, nao sucessos.** O throttler do Postiz incrementa quando a
 * requisicao chega ao guard, antes de qualquer resultado. Uma chamada que
 * retornou 500 ja consumiu cota, entao so contar o que deu certo subestimaria o
 * consumo -- e o operador veria folga onde nao ha.
 *
 * **Nunca bloqueia publicacao.** Este modulo e observabilidade: uma falha
 * aqui engole o erro e devolve zero, porque um contador quebrado nao pode
 * impedir um post de sair. O que se perde e a metrica, nao a publicacao.
 */
import { env } from '../../config';
import { createConnection } from '../../queue/redis.queue';

export type PostizQuotaBucket = 'posts' | 'uploads';

/**
 * Limites do Postiz, por organizacao. `uploads` e o mais apertado: 30 contra 90.
 * Uma imagem em 6 redes e 1 upload (o media-cache deduplica), o que ja e 1/30 da
 * cota. Por isso o upload e o numero que aperta primeiro, e nao o post.
 */
export const POSTIZ_QUOTA_LIMITS: Record<PostizQuotaBucket, number> = {
  posts: 90,
  uploads: 30,
};

/** A partir daqui o consumo e aviso, ainda com folga mas sem margem para surpresas. */
const WARN_RATIO = 0.8;

export type QuotaState = 'ok' | 'warning' | 'exhausted';

export interface PostizQuotaUsage {
  bucket: PostizQuotaBucket;
  used: number;
  limit: number;
  remaining: number;
  ratio: number;
  state: QuotaState;
  /** `false` quando o contador nao pode ser lido (sem Redis, ou Redis fora). */
  tracked: boolean;
}

/**
 * Classifica a chamada numa classe de cota. O que nao cai em nenhuma nao
 * consome os limites de 90/h e 30/h -- em especial `GET /posts/:id/missing` e
 * os endpoints de leitura de integracao.
 */
export const quotaBucketOf = (method: string, path: string): PostizQuotaBucket | null => {
  if (method === 'post' && path === '/posts') {
    return 'posts';
  }
  if (method === 'post' && path === '/upload-from-url') {
    return 'uploads';
  }
  return null;
};

let redis: ReturnType<typeof createConnection> | null = null;

const getRedis = (): ReturnType<typeof createConnection> | null => {
  if (!env.REDIS_URL) {
    return null;
  }
  redis ??= createConnection();
  return redis;
};

const WINDOW_MS = 60 * 60 * 1000;

// Recorta, conta e registra numa operacao atomica. A contagem e de janela
// deslizante, nao de bucket fixo: o Postiz tambem e, e o que importa e "quantos
// nos ultimos 60 minutos", nao "quantos neste hora cheia".
const RECORD_LUA = `
local key = KEYS[1]
local window_ms = tonumber(ARGV[1])
local now_ms = tonumber(ARGV[2])

redis.call('ZREMRANGEBYSCORE', key, 0, now_ms - window_ms)
local used = redis.call('ZCARD', key)
redis.call('ZADD', key, now_ms, now_ms .. ':' .. math.random())
redis.call('PEXPIRE', key, window_ms)
return used + 1
`;

const READ_LUA = `
local key = KEYS[1]
local window_ms = tonumber(ARGV[1])
local now_ms = tonumber(ARGV[2])

redis.call('ZREMRANGEBYSCORE', key, 0, now_ms - window_ms)
return redis.call('ZCARD', key)
`;

/** Contadores em memoria, para quando nao ha REDIS_URL (ou ele caiu). */
const memoryCounters = new Map<PostizQuotaBucket, number[]>();

const stateOf = (used: number, limit: number): QuotaState => {
  if (used >= limit) {
    return 'exhausted';
  }
  return used >= limit * WARN_RATIO ? 'warning' : 'ok';
};

const trimMemory = (bucket: PostizQuotaBucket, now: number): number[] => {
  const hits = (memoryCounters.get(bucket) ?? []).filter((at) => at > now - WINDOW_MS);
  memoryCounters.set(bucket, hits);
  return hits;
};

let warnedRedis = false;

/**
 * Registra o consumo de uma chamada. Devolve o uso resultante, ou `null` se nao
 * deu para contar -- quem chama ignora o `null` de proposito.
 */
export const recordPostizCall = async (bucket: PostizQuotaBucket): Promise<number | null> => {
  const now = Date.now();
  const client = getRedis();

  if (!client) {
    return trimMemory(bucket, now).length + 1;
  }

  try {
    const raw = await client.eval(RECORD_LUA, 1, `postizquota:${bucket}`, String(WINDOW_MS), String(now));
    return Number(raw);
  } catch (error) {
    // Uma vez por processo: se o Redis esta fora, nao e para inundar o log a
    // cada publicacao com a mesma causa.
    if (!warnedRedis) {
      warnedRedis = true;
      console.error(`[postiz-quota] Redis indisponivel, contando em memoria: ${(error as Error).message}`);
    }
    return trimMemory(bucket, now).length + 1;
  }
};

export const readPostizQuota = async (bucket: PostizQuotaBucket): Promise<PostizQuotaUsage> => {
  const limit = POSTIZ_QUOTA_LIMITS[bucket];
  const now = Date.now();
  const client = getRedis();
  let used: number | null = null;

  if (client) {
    try {
      used = Number(await client.eval(READ_LUA, 1, `postizquota:${bucket}`, String(WINDOW_MS), String(now)));
    } catch (error) {
      if (!warnedRedis) {
        warnedRedis = true;
        console.error(`[postiz-quota] leitura de cota falhou, caindo para memoria: ${(error as Error).message}`);
      }
    }
  }

  const tracked = used !== null;
  const effective = used ?? trimMemory(bucket, now).length;

  return {
    bucket,
    used: effective,
    limit,
    remaining: Math.max(0, limit - effective),
    ratio: limit > 0 ? effective / limit : 0,
    state: stateOf(effective, limit),
    tracked,
  };
};

export const readAllPostizQuota = async (): Promise<PostizQuotaUsage[]> =>
  Promise.all((Object.keys(POSTIZ_QUOTA_LIMITS) as PostizQuotaBucket[]).map((bucket) => readPostizQuota(bucket)));

/** Usado pelos testes: zera os contadores em memoria. */
export const clearPostizQuotaMemory = (): void => {
  memoryCounters.clear();
};
