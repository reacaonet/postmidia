import axios from 'axios';
import { env } from '../../config';
import { isRetryableStatus, PublishError } from '../adapter';
import type {
  PostizCreatePayload,
  PostizCreateResponse,
  PostizIntegrationSettings,
  PostizIntegrationSummary,
  PostizMediaFile,
  PostizMissingContent,
} from './types';

const client = axios.create({ timeout: 60_000 });

const request = async <T>(
  apiKey: string,
  method: 'get' | 'post' | 'delete',
  path: string,
  body?: unknown
): Promise<T> => {
  if (!apiKey) {
    throw new PublishError('postiz_no_api_key', 'Conta sem credencial Postiz', false);
  }

  try {
    const response = await client.request<T>({
      method,
      url: `${env.POSTIZ_API_BASE_URL}${path}`,
      data: body,
      headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
    });
    return response.data;
  } catch (error) {
    if (error instanceof PublishError) {
      throw error;
    }
    if (axios.isAxiosError(error)) {
      const status = error.response?.status ?? 0;
      const authFailure = status === 401 || status === 403;
      throw new PublishError(
        `postiz_http_${status || 'network'}`,
        error.message,
        isRetryableStatus(status),
        status,
        authFailure
      );
    }
    throw new PublishError('postiz_unexpected', String(error), false);
  }
};

export const postizCreatePost = (
  apiKey: string,
  payload: PostizCreatePayload
): Promise<PostizCreateResponse> => request<PostizCreateResponse>(apiKey, 'post', '/posts', payload);

/**
 * Extensoes aceitas pelo /upload-from-url do Postiz. O servidor valida isso
 * antes de baixar o arquivo e responde 400 "File must have a valid extension".
 * Sem esta checagem, uma URL assinada de CDN (sem extensao no final do path)
 * vira um 400 opaco do Postiz so depois de gastar o round-trip -- e ainda entra
 * no cache de midia como se fosse um erro transitorio.
 */
const UPLOAD_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'mp4']);

const extensionOfPath = (url: string): string => {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    // Nao parseavel como URL absoluta: cai no split simples.
    pathname = url.split('?')[0].split('#')[0];
  }
  const lastSegment = pathname.slice(pathname.lastIndexOf('/') + 1);
  const lastDot = lastSegment.lastIndexOf('.');
  return lastDot <= 0 ? '' : lastSegment.slice(lastDot + 1).toLowerCase();
};

export const postizUploadFromUrl = async (
  apiKey: string,
  url: string
): Promise<PostizMediaFile> => {
  const extension = extensionOfPath(url);
  if (!UPLOAD_EXTENSIONS.has(extension)) {
    throw new PublishError(
      'postiz_media_extension_unsupported',
      `Postiz so aceita ${[...UPLOAD_EXTENSIONS].map((e) => '.' + e).join(', ')} e a URL nao termina em extensao valida: ${url}`,
      false
    );
  }
  return request<PostizMediaFile>(apiKey, 'post', '/upload-from-url', { url });
};

export const postizIntegrationSettings = (
  apiKey: string,
  integrationId: string
): Promise<{ output: PostizIntegrationSettings }> =>
  request<{ output: PostizIntegrationSettings }>(
    apiKey,
    'get',
    `/integration-settings/${encodeURIComponent(integrationId)}`
  );

export const postizListIntegrations = (
  apiKey: string
): Promise<PostizIntegrationSummary[]> => request<PostizIntegrationSummary[]>(apiKey, 'get', '/integrations');

/**
 * Procura o id que o provedor ainda nao devolveu para um post.
 *
 * O Postiz responde `[]` em tres casos distintos, e a distincao importa:
 * o post ja foi resolvido (`releaseId` deixou de ser `'missing'`), a rede nao
 * tem handler de missing, ou o provedor ainda nao processou. O chamador trata
 * `[]` como "nada a fazer agora" e tenta de novo na proxima passada; nenhum
 * desses casos e erro.
 *
 * Este endpoint NAO conta para o orcamento de 90/h: o ThrottlerGuard global do
 * Postiz so intercepta `POST /public/v1/posts`. O risco real aqui e o tempo --
 * `getMissingContent` pode renovar token e, em integrations com `refreshWait`,
 * dormir 10s dentro da chamada.
 */
export const postizGetMissingContent = (
  apiKey: string,
  postId: string
): Promise<PostizMissingContent[]> =>
  request<PostizMissingContent[]>(
    apiKey,
    'get',
    `/posts/${encodeURIComponent(postId)}/missing`
  );
