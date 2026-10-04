import axios from 'axios';
import { providerHttp } from './provider-http';
import type { MediaRef, ResolvedChannelAccount } from '../domain/types';
import {
  assertPublishable,
  isRetryableStatus,
  PublishError,
  validateAgainstNetworkSpec,
  type ChannelAdapter,
  type PublishResult,
  type PublishSpec,
  type ValidationIssue,
} from './adapter';

/**
 * LinkedIn nativo: o token colado no painel e a unica credencial.
 *
 * Antes desta rota o LinkedIn era servido pelo Postiz, e ai os dois campos do
 * formulario de conta tinham que ser valores do Postiz -- `externalAccountId`
 * era o id de uma integracao na base do Postiz e o `secret` era a chave publica
 * daquele Postiz. Isso obrigava a cadastro em tres lugares: app do LinkedIn,
 * container do Postiz e painel daqui.
 *
 * Nativo, o mesmo campo vira o token de membro que a pessoa conectou, e o
 * `externalAccountId` vira o URN que o proprio LinkedIn devolve na validacao
 * (`urn:li:person:<sub>`). Um lugar so.
 */

const REST = 'https://api.linkedin.com/rest';
const UGC_HOST = 'https://api.linkedin.com/v2';

interface LinkedinPostResponse {
  id?: string;
  'x-restli-id'?: string;
  headers?: Record<string, string>;
}

const headersFor = (secret: string): Record<string, string> => ({
  Authorization: `Bearer ${secret}`,
  'LinkedIn-Version': '202405',
  'X-Restli-Protocol-Version': '2.0.0',
  'Content-Type': 'application/json',
});

/**
 * Traduz a falha do LinkedIn em PublishError.
 *
 * O caso que mais importa aqui e o 403 sem `X-RestLi-Error-Reason`: e o token
 * valido, mas sem os escopos de escrita (`w_member_social`) na versao do produto
 * -- a "versao" e a chave do produto/apps, separada do Developer Portal. Sem
 * distinguir isso de 403 por bloqueio, o operador sobe o erro e nao sabe se
 * faltam escopos ou se a conta foi suspensa.
 */
const failFrom = (error: unknown, context: string): never => {
  if (!axios.isAxiosError(error)) {
    throw error;
  }

  const status = error.response?.status ?? 0;
  const reason = error.response?.headers?.['x-restli-error-reason'] as string | undefined;
  const body = error.response?.data as { message?: string; status?: string } | undefined;
  const serviceError = body?.message ?? error.message;

  if (status === 401) {
    throw new PublishError(
      'linkedin_401',
      `LinkedIn recusou o token em ${context}. O access token expirou ou foi revogado; gere outro.`,
      false,
      status,
      true
    );
  }

  if (status === 403) {
    throw new PublishError(
      'linkedin_403',
      reason
        ? `LinkedIn recusou ${context}: ${reason}. Cheque o escopo w_member_social e as versoes do produto do app.`
        : `LinkedIn recusou ${context}: ${serviceError}`,
      false,
      status
    );
  }

  if (status === 422) {
    throw new PublishError('linkedin_422', `LinkedIn recusou ${context}: ${serviceError}`, false, status);
  }

  throw new PublishError(
    `linkedin_${status || 'request_failed'}`,
    `Falha ao ${context}: ${serviceError}`,
    isRetryableStatus(status),
    status
  );
};

interface UploadedAsset {
  id: string;
}

/**
 * Sobe os bytes da imagem no bucket do LinkedIn e devolve o urn do asset.
 *
 * A API de postagem do LinkedIn nao aceita URL de imagem: so aceita o `urn` do
 * asset que o proprio LinkedIn hospeda. Como o painel traz midia por URL, os
 * bytes precisam ser baixados aqui e reenviados -- nao ha como contornar sem
 * storage proprio.
 */
const uploadImage = async (
  secret: string,
  media: MediaRef,
  owner: string
): Promise<UploadedAsset> => {
  let downloaded: Buffer;

  try {
    const response = await providerHttp.get(media.url, { responseType: 'arraybuffer' });
    downloaded = Buffer.from(response.data as ArrayBuffer);
  } catch (error) {
    if (axios.isAxiosError(error) && error.response?.status === 404) {
      throw new PublishError('linkedin_media_404', `Midia nao encontrada: ${media.url}`, false, 404);
    }
    throw new PublishError(
      'linkedin_media_unreachable',
      `Nao consegui baixar a midia ${media.url}: ${axios.isAxiosError(error) ? error.message : String(error)}`,
      true
    );
  }

  let initialized: { value?: string; uploadUrl?: string };
  try {
    const response = await providerHttp.post<Initialized>(
      `${REST}/images?action=initializeUpload`,
      {
        initializeUploadRequest: {
          // O `owner` tem que ser o autor do post. Um URN fixo -- ou o
          // placeholder `organization:0` que estava aqui -- faz o LinkedIn
          // recusar com 403, porque o asset ficaria pertencendo a outra conta.
          owner,
          fileSizeBytes: downloaded.length,
        },
      },
      { headers: headersFor(secret) }
    );
    initialized = response.data;
  } catch (error) {
    return failFrom(error, 'inicializar upload da imagem');
  }

  const imageUrn = initialized.value;
  const uploadUrl = initialized.uploadUrl;

  if (!imageUrn || !uploadUrl) {
    throw new PublishError(
      'linkedin_media_init_failed',
      `LinkedIn nao devolveu uploadUrl: ${JSON.stringify(initialized)}`,
      false
    );
  }

  try {
    // `PUT`, nao `POST`: o `uploadUrl` devolvido pelo initializeUpload aceita
    // os bytes em PUT. Com POST o bucket responde 405 e a imagem nunca sobe.
    await providerHttp.put(uploadUrl, downloaded, {
      headers: { 'Content-Type': 'application/octet-stream' },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });
  } catch (error) {
    return failFrom(error, 'enviar os bytes da imagem');
  }

  return { id: imageUrn };
};

interface Initialized {
  value?: string;
  uploadUrl?: string;
}

export const createLinkedinAdapter = (): ChannelAdapter => ({
  network: 'linkedin',
  capabilities: {
    nativeScheduling: false,
    twoStepPublish: true,
    metrics: false,
    commentReply: true,
  },

  async validate(spec: PublishSpec, account: ResolvedChannelAccount): Promise<ValidationIssue[]> {
    const issues = validateAgainstNetworkSpec('linkedin', spec, account);

    if (spec.media.some((item) => item.kind === 'video')) {
      issues.push({
        field: 'media',
        code: 'linkedin_video_unsupported',
        message:
          'LinkedIn nativo ainda nao publica video: a API exige thumbnail e finalizeUpload. ' +
          'Use imagem ou texto por enquanto.',
      });
    }

    return issues;
  },

  async publish(spec: PublishSpec, account: ResolvedChannelAccount): Promise<PublishResult> {
    assertPublishable('linkedin', spec, account);

    if (!account.secret) {
      throw new PublishError('linkedin_not_configured', 'Conta sem access token', false);
    }

    const author = account.externalAccountId.trim();
    if (!author.startsWith('urn:li:')) {
      throw new PublishError(
        'linkedin_bad_author',
        `Conta sem URN do LinkedIn: "${author}". Re-registre a conta para o LinkedIn confirmar o URN.`,
        false
      );
    }

    const images = spec.media.filter((item) => item.kind === 'image');

    const body: Record<string, unknown> = {
      author,
      commentary: spec.text,
      visibility: 'PUBLIC',
      lifecycleState: 'PUBLISHED',
      distribution: {
        feedDistribution: 'MAIN_FEED',
        targetEntities: [],
        thirdPartyDistributionChannels: [],
      },
    };

    if (images.length > 0) {
      const assets = await Promise.all(
      images.slice(0, 9).map((item) => uploadImage(account.secret, item, author))
    );
      body.content = {
        media: {
          id: assets[0].id,
          altText: spec.text.slice(0, 300) || undefined,
          title: spec.text.slice(0, 100) || undefined,
        },
      };
    }

    let created: LinkedinPostResponse;
    try {
      const response = await providerHttp.post<LinkedinPostResponse>(`${REST}/posts`, body, {
        headers: headersFor(account.secret),
      });
      created = { ...response.data, headers: response.headers as unknown as Record<string, string> };
    } catch (error) {
      return failFrom(error, 'publicar');
    }

    const externalPostId = created['x-restli-id'] ?? created.id ?? '';
    const location = created.headers?.location ?? created.headers?.Location ?? null;

    return {
      externalPostId,
      permalink: location ?? (externalPostId ? `${UGC_HOST}/posts/${externalPostId}` : null),
      releaseIdMissing: !externalPostId,
      reconcilable: !externalPostId,
      raw: created,
    };
  },
});