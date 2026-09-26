import type { MediaRef, PostMetrics, ResolvedChannelAccount } from '../domain/types';
import { NETWORK_SPECS, type Network } from '../domain/networks';

export interface PublishSpec {
  text: string;
  media: MediaRef[];
  contentType: string;
  settings: Record<string, unknown>;
  recipient: string | null;
  idempotencyKey: string;
}

export interface PublishResult {
  externalPostId: string;
  permalink: string | null;
  releaseIdMissing: boolean;
  raw: unknown;
}

export type ValidationField = 'text' | 'media' | 'contentType' | 'account';

export interface ValidationIssue {
  field: ValidationField;
  code: string;
  message: string;
}

export interface ChannelCapabilities {
  nativeScheduling: boolean;
  twoStepPublish: boolean;
  metrics: boolean;
  commentReply: boolean;
}

export interface ChannelAdapter {
  readonly network: Network;
  readonly capabilities: ChannelCapabilities;
  validate(spec: PublishSpec, account: ResolvedChannelAccount): Promise<ValidationIssue[]>;
  publish(spec: PublishSpec, account: ResolvedChannelAccount): Promise<PublishResult>;
  fetchMetrics?(externalPostId: string, account: ResolvedChannelAccount): Promise<PostMetrics>;
}

export class PublishError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly httpStatus?: number,
    readonly authFailure: boolean = false
  ) {
    super(message);
    this.name = 'PublishError';
  }
}

export const isRetryableStatus = (status: number): boolean =>
  status === 408 || status === 425 || status === 429 || status >= 500;

const extensionOf = (url: string): string => {
  const withoutQuery = url.split('?')[0];
  const lastDot = withoutQuery.lastIndexOf('.');
  return lastDot === -1 ? '' : withoutQuery.slice(lastDot + 1).toLowerCase();
};

export const validateAgainstNetworkSpec = (
  network: Network,
  spec: PublishSpec,
  account: ResolvedChannelAccount
): ValidationIssue[] => {
  const networkSpec = NETWORK_SPECS[network];
  const issues: ValidationIssue[] = [];

  if (account.network !== network) {
    issues.push({
      field: 'account',
      code: 'account_network_mismatch',
      message: `Conta pertence a ${account.network}, adapter e ${network}`,
    });
  }

  if (account.status !== 'active') {
    issues.push({
      field: 'account',
      code: 'account_not_active',
      message: `Conta em status ${account.status}; reconecte antes de publicar`,
    });
  }

  if (spec.text.trim().length === 0 && spec.media.length === 0) {
    issues.push({ field: 'text', code: 'empty_content', message: 'Post sem texto e sem midia' });
  }

  // Fase 7: o limite vem do provedor quando a conta ja foi sincronizada. O
  // NETWORK_SPECS e apenas o fallback para conta sem sync ou quando o provedor
  // nao declara maxLength. Aceitar o menor dos dois (e nao o maior) evita que
  // um fallback antigo passe um post que a rede recusa.
  const providerMaxLength =
    typeof account.providerMaxLength === 'number' && account.providerMaxLength > 0
      ? account.providerMaxLength
      : null;
  const maxChars = providerMaxLength ?? networkSpec.text.maxChars;
  const maxCharsSource = providerMaxLength === null ? 'limite da rede' : 'limite do provedor';

  if (spec.text.length > maxChars) {
    issues.push({
      field: 'text',
      code: 'text_too_long',
      message:
        `${spec.text.length} caracteres excede o ${maxCharsSource} de ${maxChars} em ` +
        `${networkSpec.label}${providerMaxLength !== null && providerMaxLength !== networkSpec.text.maxChars ? ` (NETWORK_SPECSassume ${networkSpec.text.maxChars})` : ''}`,
    });
  }

  const contentType = networkSpec.contentTypes.find((candidate) => candidate.id === spec.contentType);
  if (!contentType) {
    issues.push({
      field: 'contentType',
      code: 'unknown_content_type',
      message: `Formato "${spec.contentType}" nao existe em ${networkSpec.label}`,
    });
    return issues;
  }

  if (networkSpec.text.requiresMedia && spec.media.length === 0) {
    issues.push({
      field: 'media',
      code: 'media_required',
      message: `${networkSpec.label} exige midia para este formato`,
    });
  }

  const images = spec.media.filter((item) => item.kind === 'image');
  const videos = spec.media.filter((item) => item.kind === 'video');

  if (images.length > networkSpec.text.maxImages) {
    issues.push({
      field: 'media',
      code: 'too_many_images',
      message: `${images.length} imagens excede o limite de ${networkSpec.text.maxImages}`,
    });
  }

  if (videos.length > networkSpec.text.maxVideos) {
    issues.push({
      field: 'media',
      code: 'too_many_videos',
      message: `${videos.length} videos excede o limite de ${networkSpec.text.maxVideos}`,
    });
  }

  for (const image of images) {
    if (!contentType.acceptsImage) {
      issues.push({
        field: 'media',
        code: 'image_not_accepted',
        message: `Formato ${contentType.label} em ${networkSpec.label} nao aceita imagem`,
      });
    }
    if (image.bytes !== undefined && image.bytes > networkSpec.media.maxImageBytes) {
      issues.push({
        field: 'media',
        code: 'image_too_large',
        message: `Imagem de ${image.bytes} bytes excede o limite de ${networkSpec.media.maxImageBytes}`,
      });
    }
  }

  for (const video of videos) {
    if (!contentType.acceptsVideo) {
      issues.push({
        field: 'media',
        code: 'video_not_accepted',
        message: `Formato ${contentType.label} em ${networkSpec.label} nao aceita video`,
      });
    }
    if (video.bytes !== undefined && video.bytes > networkSpec.media.maxVideoBytes) {
      issues.push({
        field: 'media',
        code: 'video_too_large',
        message: `Video de ${video.bytes} bytes excede o limite de ${networkSpec.media.maxVideoBytes}`,
      });
    }
    if (
      video.durationSeconds !== undefined &&
      video.durationSeconds > contentType.maxVideoSeconds
    ) {
      issues.push({
        field: 'media',
        code: 'video_too_long',
        message: `Video de ${video.durationSeconds}s excede ${contentType.maxVideoSeconds}s do formato ${contentType.label}`,
      });
    }
    const extension = extensionOf(video.url);
    if (extension && !networkSpec.media.videoFormats.includes(extension)) {
      issues.push({
        field: 'media',
        code: 'video_format_unsupported',
        message: `Formato .${extension} nao aceito em ${networkSpec.label} (aceitos: ${networkSpec.media.videoFormats.join(', ')})`,
      });
    }
  }

  return issues;
};

export const assertPublishable = (
  network: Network,
  spec: PublishSpec,
  account: ResolvedChannelAccount
): void => {
  const issues = validateAgainstNetworkSpec(network, spec, account);
  if (issues.length > 0) {
    throw new PublishError(
      'validation_failed',
      issues.map((issue) => `${issue.code}: ${issue.message}`).join('; '),
      false
    );
  }
};
