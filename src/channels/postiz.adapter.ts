import type { Network } from '../domain/networks';
import type { ResolvedChannelAccount } from '../domain/types';
import {
  assertPublishable,
  PublishError,
  validateAgainstNetworkSpec,
  type ChannelAdapter,
  type PublishResult,
  type PublishSpec,
  type ValidationIssue,
} from './adapter';
import { postizCreatePost, postizUploadFromUrl } from './postiz/client';
import { resolveMediaAsset } from './postiz/media-cache';
import { buildPostizSettings, collectedSettingsTags, tikTokPostingMethod } from './postiz/settings';
import type { PostizCreatePayload } from './postiz/types';

const MISSING_RELEASE_ID = 'missing';

export const createPostizAdapter = (network: Network): ChannelAdapter => ({
  network,
  capabilities: {
    nativeScheduling: false,
    twoStepPublish: true,
    metrics: true,
    commentReply: true,
  },

  async validate(spec: PublishSpec, account: ResolvedChannelAccount): Promise<ValidationIssue[]> {
    const base = validateAgainstNetworkSpec(network, spec, account);
    const { issues } = buildPostizSettings(network, spec);
    return [...base, ...issues];
  },

  async publish(spec: PublishSpec, account: ResolvedChannelAccount): Promise<PublishResult> {
    assertPublishable(network, spec, account);

    const { settings } = buildPostizSettings(network, spec);
    if (!settings) {
      throw new PublishError('unsupported_by_postiz', `Postiz nao atende ${network}`, false);
    }

    // `Promise.all` aqui e o que transforma N midias em N uploads. Deduplicar
    // por URL (no media-cache) resolve URLs repetidas, mas nao midias distintas
    // no mesmo post -- e a cota e 30/h, nao 30 por post. O limite por rede ja
    // barra o pior caso (1 video, 1..35 imagens); o que sobra e o custo real.
    const images = await Promise.all(
      spec.media.map((item) =>
        resolveMediaAsset(
          account.tenantId,
          account.id,
          account.secret,
          item.url,
          postizUploadFromUrl
        )
      )
    );

    const payload: PostizCreatePayload = {
      type: 'now',
      date: new Date().toISOString(),
      shortLink: false,
      tags: collectedSettingsTags(spec),
      posts: [
        {
          integration: { id: account.externalAccountId },
          value: [
            {
              content: spec.text,
              image: images.map((asset) => ({ id: asset.id, path: asset.path })),
            },
          ],
          settings,
        },
      ],
    };

    const response = await postizCreatePost(account.secret, payload);
    const first = response.posts?.[0];
    const postizPostId = first?.id ?? response.id ?? null;

    if (!postizPostId) {
      throw new PublishError(
        'postiz_unexpected_response',
        `Postiz nao retornou id do post: ${JSON.stringify(response)}`,
        false
      );
    }

    const releaseId = first?.releaseId ?? null;
    const uploadOnlyMode = network === 'tiktok' && tikTokPostingMethod(spec) === 'UPLOAD';
    const releaseIdMissing = uploadOnlyMode || !releaseId || releaseId === MISSING_RELEASE_ID;

    return {
      externalPostId: releaseIdMissing ? postizPostId : releaseId,
      permalink: null,
      releaseIdMissing,
      // No modo UPLOAD o TikTok nao devolve id em momento algum, entao o job
      // fica com o id interno do Postiz e nao entra na fila de reconciliacao.
      reconcilable: releaseIdMissing && !uploadOnlyMode,
      raw: response,
    };
  },
});
