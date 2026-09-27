import type { PostizMediaFile } from './types';

/**
 * Cache de `upload-from-url`, em memoria do processo.
 *
 * Existe por cota, nao por performance: cada upload gasta um dos 30 slots por
 * hora do Postiz, entao a mesma URL reenviada tem de custar uma vez so.
 *
 * **A chave inclui a conta.** Antes era `${tenantId}:${url}`, e cada linha de
 * `channel_accounts` tem o seu proprio `secret`. Duas contas do mesmo tenant
 * recebiam o `{id, path}` produzido pela chave da primeira, e o `id` do Postiz
 * so resolve dentro da organizacao que o gerou. O tenant ser o mesmo nao torna
 * as contas intercambiaveis.
 *
 * **TTL e limite.** O `Map` nao tinha nenhum dos dois: um worker de longa vida
 * acumulava um item por midia para sempre, e o cache morria com o processo
 * (cada worker tinha o seu). Um id do Postiz lido de um cache velho pode ja ter
 * expirado la, entao segurar o item indefinidamente compra erro, nao aceleracao.
 */
interface CacheEntry {
  file: PostizMediaFile;
  expiresAt: number;
}

/** 6h: bem acima do tempo de um job, e bem abaixo de "para sempre". */
const TTL_MS = 6 * 3_600_000;

/** Teto de entradas. Sobrepassando, descarta as mais antigas. */
const MAX_ENTRIES = 5_000;

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<PostizMediaFile>>();

const evictIfNeeded = (): void => {
  if (cache.size <= MAX_ENTRIES) {
    return;
  }
  // `Map` preserva a ordem de insercao, entao a primeira chave e a mais antiga.
  const excess = cache.size - MAX_ENTRIES;
  let removed = 0;
  for (const key of cache.keys()) {
    cache.delete(key);
    removed += 1;
    if (removed >= excess) {
      break;
    }
  }
};

export const resolveMediaAsset = async (
  tenantId: string,
  accountId: string,
  apiKey: string,
  url: string,
  upload: (apiKey: string, url: string) => Promise<PostizMediaFile>
): Promise<PostizMediaFile> => {
  const key = `${tenantId}:${accountId}:${url}`;

  const cached = cache.get(key);
  if (cached) {
    if (cached.expiresAt > Date.now()) {
      return cached.file;
    }
    // Expirado: o id pode ter sumido do lado do Postiz. Melhor um upload novo
    // (que custa cota) do que um id morto (que falha o job e vai para a DLQ).
    cache.delete(key);
  }

  const pending = inFlight.get(key);
  if (pending) {
    return pending;
  }

  const promise = upload(apiKey, url)
    .then((file) => {
      cache.set(key, { file, expiresAt: Date.now() + TTL_MS });
      evictIfNeeded();
      inFlight.delete(key);
      return file;
    })
    .catch((error) => {
      inFlight.delete(key);
      throw error;
    });

  inFlight.set(key, promise);
  return promise;
};

export const mediaCacheSize = (): number => cache.size;

export const clearMediaCache = (): void => {
  cache.clear();
  inFlight.clear();
};
