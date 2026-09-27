import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { providerHttp } from './provider-http';
import { env } from '../config';
import type { MediaRef } from '../domain/types';

/**
 * Descobre o tamanho e o tipo real de uma midia a partir da URL, para a
 * validacao de tamanho deixar de depender do cliente.
 *
 * **O buraco que isto fecha.** `validateAgainstNetworkSpec` so checava
 * `image_too_large` quando o cliente mandava `bytes`. Nada no servidor derivava
 * o valor, entao um post com uma imagem de 80 MB para o Instagram (limite 8 MB)
 * passava pela validacao inteira: criava job, ocupava cota, queimava as cinco
 * tentativas no backoff e morria na fila morta. O limite existia no codigo e
 * nao valia nada.
 *
 * **Por que HEAD e nao GET.** HEAD traz `Content-Length` sem body. Quando o host
 * recusa HEAD (405, comum em CDN), cai para um GET com `Range: bytes=0-0`: o
 * servidor responde 206 e o tamanho total vem no `Content-Range`, com um byte de
 * corpo. Nunca baixa o arquivo.
 *
 * **Nao lanca.** Devolve `null` quando nao soube. A checagem de tamanho e
 * melhor-esforco: um host que recusa HEAD ou um DNS que falha nao pode impedir
 * o agendamento de um post legitimo. A autoridade definitiva do tamanho vem com
 * o storage proprio da Fase 8, onde o arquivo passa pela nossa mao.
 *
 * **A guarda de SSRF e obrigatoria.** Fazer o servidor sondar uma URL que o
 * cliente escolheu abre, sozinho, acesso a rede interna: link-local de metadados
 * de nuvem, Redis e Postgres em rede privada, portas de admin. Sem isto, a
 * "correcao" da validacao seria a criacao de uma vulnerabilidade. Por isso
 * resolve-se o nome e recusa-se qualquer endereco que nao seja publico.
 */
export interface MediaProbeResult {
  bytes: number | null;
  contentType: string | null;
}

const TIMEOUT_MS = 3_000;
const MAX_CACHE_ENTRIES = 1_000;
/** 10min: imutavel no periodo, e evita sondar a mesma URL a cada retry. */
const CACHE_TTL_MS = 10 * 60_000;

const cache = new Map<string, { value: MediaProbeResult; expiresAt: number }>();

/**
 * Faixas que nunca devem ser alcancaveis por URL fornecida por cliente.
 *
 * Inclui as reservadas/nao roteaveis alem do obvious, porque `0.0.0.0/8` e
 * `100.64/10` (CGNAT) aparecem com frequencia suficiente em infra real para
 * valer a checagem.
 */
const isBlockedIpv4 = (ip: string): boolean => {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) {
    return true;
  }
  if (a === 172 && b >= 16 && b <= 31) {
    return true;
  }
  if (a === 192 && b === 168) {
    return true;
  }
  if (a === 169 && b === 254) {
    return true;
  }
  if (a === 100 && b >= 64 && b <= 127) {
    return true;
  }
  if (a === 192 && b === 0) {
    return true;
  }
  if (a === 198 && (b === 18 || b === 19)) {
    return true;
  }
  // Multicast (224/4) e reservada (240/4).
  if (a >= 224) {
    return true;
  }
  return false;
};

const isBlockedIpv6 = (ip: string): boolean => {
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') {
    return true;
  }
  // ULA fc00::/7 e link-local fe80::/10.
  if (/^f[cd]/.test(lower)) {
    return true;
  }
  if (/^fe[89ab]/.test(lower)) {
    return true;
  }
  // IPv4 mapeado em IPv6: a checagem tem que olhar o endereco embutido.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) {
    return isBlockedIpv4(mapped[1]);
  }
  return false;
};

const isBlockedIp = (ip: string): boolean =>
  isIP(ip) === 4 ? isBlockedIpv4(ip) : isBlockedIpv6(ip);

/**
 * Resolve e decide. Um nome que resolve para um endereco publico E um privado e
 * recusado: recusar o privado e o que fecha a porta, e o nome e controlado pelo
 * cliente.
 *
 * Risco residual conhecido (DNS rebinding): o axios re-resolve o nome na hora do
 * request, e a resposta do `lookup` pode ser antiga. O expoe e apenas tamanho e
 * tipo, nunca o conteudo, e o fim real -- nao sondar URL arbitraria -- chega com
 * o storage da Fase 8.
 */
const isProbeable = async (url: string): Promise<boolean> => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return false;
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');

  // So os testes servem midia em loopback, e o boot de producao recusa o processo
  // com isto ligado. Fora dos testes, nenhuma URL privada e sondada.
  if (env.MEDIA_PROBE_ALLOW_PRIVATE) {
    return true;
  }

  if (hostname.toLowerCase() === 'localhost') {
    return false;
  }

  // IP literal no proprio host: nao ha DNS para checar.
  if (isIP(hostname)) {
    return !isBlockedIp(hostname);
  }

  let addresses: { address: string }[];
  try {
    addresses = await lookup(hostname, { all: true });
  } catch {
    return false;
  }
  if (addresses.length === 0) {
    return false;
  }
  return addresses.every((entry) => !isBlockedIp(entry.address));
};

const readContentLength = (headers: Record<string, unknown>): number | null => {
  const raw =
    (headers['content-range'] as string | undefined) ??
    (headers['content-length'] as string | undefined);
  if (!raw) {
    return null;
  }
  // `Content-Range: bytes 0-0/8388608` -> 8388608
  const range = /\/(\d+)\s*$/.exec(raw);
  const value = Number(range ? range[1] : raw);
  return Number.isFinite(value) && value > 0 ? value : null;
};

const probeOnce = async (url: string): Promise<MediaProbeResult> => {
  // Sem seguir redirect: um 302 para `http://169.254.169.254/` contornaria a
  // guarda, porque o destino so e conhecido DEPOIS da decisao.
  const options = { timeout: TIMEOUT_MS, maxRedirects: 0 as const };

  try {
    const head = await providerHttp.head(url, options);
    const bytes = readContentLength(head.headers as Record<string, unknown>);
    if (bytes !== null) {
      return { bytes, contentType: (head.headers['content-type'] as string) ?? null };
    }
  } catch {
    // Cai no GET ranged abaixo: recusar HEAD e o caso comum de CDN.
  }

  try {
    const get = await providerHttp.get(url, {
      ...options,
      headers: { Range: 'bytes=0-0' },
      // O corpo e descartado: so interessa o header.
      responseType: 'stream',
    });
    const bytes = readContentLength(get.headers as Record<string, unknown>);
    const contentType = (get.headers['content-type'] as string) ?? null;
    get.data?.destroy?.();
    return { bytes, contentType };
  } catch {
    return { bytes: null, contentType: null };
  }
};

export const probeMedia = async (url: string): Promise<MediaProbeResult> => {
  if (!env.MEDIA_PROBE_ENABLED) {
    return { bytes: null, contentType: null };
  }

  const cached = cache.get(url);
  if (cached) {
    if (cached.expiresAt > Date.now()) {
      return cached.value;
    }
    cache.delete(url);
  }

  const value = (await isProbeable(url)) ? await probeOnce(url) : { bytes: null, contentType: null };

  if (cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next();
    if (!oldest.done) {
      cache.delete(oldest.value);
    }
  }
  cache.set(url, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
};

export const clearMediaProbeCache = (): void => {
  cache.clear();
};

/**
 * Preenche `bytes` e `mimeType` quando o cliente nao mandou, sem sobrescrever o
 * que veio.
 *
 * Devolve uma COPIA. O `Post.media` guardado no store e' compartilhado, e mutar o
 * objeto que veio no corpo da requisicao vazaria de uma validacao para a
 * seguinte.
 */
export const enrichMedia = async (media: MediaRef[]): Promise<MediaRef[]> => {
  if (media.length === 0 || media.every((item) => item.bytes !== undefined)) {
    return media;
  }

  return await Promise.all(
    media.map(async (item) => {
      if (item.bytes !== undefined) {
        return item;
      }
      const result = await probeMedia(item.url);
      if (result.bytes === null) {
        return item;
      }
      return {
        ...item,
        bytes: result.bytes,
        mimeType: item.mimeType ?? result.contentType ?? undefined,
      };
    })
  );
};
