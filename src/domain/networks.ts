export type Network =
  | 'instagram'
  | 'facebook'
  | 'linkedin'
  | 'tiktok'
  | 'youtube'
  | 'x'
  | 'telegram'
  | 'whatsapp';

export type Aspect = 'square' | 'vertical' | 'landscape' | 'any';
export type MediaKind = 'image' | 'video';

/**
 * Redes cuja publicacao e delegada ao Postiz. Telegram e WhatsApp sao nativos,
 * entao nao tem provedor autoritativo de specs para consultar (Fase 7).
 */
export const POSTIZ_BRIDGED_NETWORKS: readonly Network[] = [
  'instagram',
  'facebook',
  'linkedin',
  'tiktok',
  'youtube',
  'x',
];

/**
 * Se a rede tem provedor autoritativo de specs. Para as nativas a resposta
 * seria sempre o fallback, entao consultar o provador so geraria 404 e cache
 * vazio sem ganho.
 */
export const isProviderSpecApplicable = (network: Network): boolean =>
  POSTIZ_BRIDGED_NETWORKS.includes(network);

export interface ContentTypeSpec {
  id: string;
  label: string;
  aspect: Aspect;
  maxVideoSeconds: number;
  acceptsImage: boolean;
  acceptsVideo: boolean;
}

export interface NetworkSpec {
  network: Network;
  label: string;
  text: {
    maxChars: number;
    maxImages: number;
    maxVideos: number;
    requiresMedia: boolean;
  };
  media: {
    maxImageBytes: number;
    maxVideoBytes: number;
    videoFormats: readonly string[];
  };
  rateLimit: {
    windowSeconds: number;
    maxPublishes: number;
  };
  features: {
    nativeScheduling: boolean;
    twoStepPublish: boolean;
    metrics: boolean;
    commentReply: boolean;
  };
  contentTypes: readonly ContentTypeSpec[];
  requiresMessageTemplate: boolean;
}

const MB = 1024 * 1024;
const GB = 1024 * MB;

export const NETWORK_SPECS: Record<Network, NetworkSpec> = {
  instagram: {
    network: 'instagram',
    label: 'Instagram',
    text: { maxChars: 2200, maxImages: 10, maxVideos: 1, requiresMedia: true },
    media: { maxImageBytes: 8 * MB, maxVideoBytes: 4 * GB, videoFormats: ['mp4', 'mov'] },
    rateLimit: { windowSeconds: 86_400, maxPublishes: 25 },
    features: { nativeScheduling: true, twoStepPublish: true, metrics: true, commentReply: true },
    contentTypes: [
      { id: 'feed', label: 'Feed', aspect: 'any', maxVideoSeconds: 3600, acceptsImage: true, acceptsVideo: true },
      { id: 'reel', label: 'Reel', aspect: 'vertical', maxVideoSeconds: 90, acceptsImage: false, acceptsVideo: true },
      { id: 'story', label: 'Story', aspect: 'vertical', maxVideoSeconds: 60, acceptsImage: true, acceptsVideo: true },
      { id: 'carousel', label: 'Carrossel', aspect: 'any', maxVideoSeconds: 3600, acceptsImage: true, acceptsVideo: true },
    ],
    requiresMessageTemplate: false,
  },
  facebook: {
    network: 'facebook',
    label: 'Facebook',
    text: { maxChars: 63_206, maxImages: 10, maxVideos: 1, requiresMedia: false },
    media: { maxImageBytes: 25 * MB, maxVideoBytes: 10 * GB, videoFormats: ['mp4', 'mov'] },
    rateLimit: { windowSeconds: 86_400, maxPublishes: 50 },
    features: { nativeScheduling: false, twoStepPublish: false, metrics: true, commentReply: true },
    contentTypes: [
      { id: 'feed', label: 'Feed', aspect: 'any', maxVideoSeconds: 14_400, acceptsImage: true, acceptsVideo: true },
      { id: 'reel', label: 'Reel', aspect: 'vertical', maxVideoSeconds: 90, acceptsImage: false, acceptsVideo: true },
      { id: 'story', label: 'Story', aspect: 'vertical', maxVideoSeconds: 60, acceptsImage: true, acceptsVideo: true },
    ],
    requiresMessageTemplate: false,
  },
  linkedin: {
    network: 'linkedin',
    label: 'LinkedIn',
    text: { maxChars: 3000, maxImages: 9, maxVideos: 1, requiresMedia: false },
    media: { maxImageBytes: 5 * MB, maxVideoBytes: 5 * GB, videoFormats: ['mp4'] },
    rateLimit: { windowSeconds: 86_400, maxPublishes: 100 },
    features: { nativeScheduling: true, twoStepPublish: true, metrics: true, commentReply: true },
    contentTypes: [
      { id: 'feed', label: 'Feed', aspect: 'any', maxVideoSeconds: 600, acceptsImage: true, acceptsVideo: true },
      { id: 'article', label: 'Artigo', aspect: 'any', maxVideoSeconds: 0, acceptsImage: true, acceptsVideo: false },
    ],
    requiresMessageTemplate: false,
  },
  tiktok: {
    network: 'tiktok',
    label: 'TikTok',
    text: { maxChars: 2200, maxImages: 35, maxVideos: 1, requiresMedia: true },
    media: { maxImageBytes: 10 * MB, maxVideoBytes: 4 * GB, videoFormats: ['mp4', 'webm'] },
    rateLimit: { windowSeconds: 86_400, maxPublishes: 15 },
    features: { nativeScheduling: true, twoStepPublish: true, metrics: true, commentReply: true },
    contentTypes: [
      { id: 'video', label: 'Video', aspect: 'vertical', maxVideoSeconds: 3600, acceptsImage: false, acceptsVideo: true },
      { id: 'photo', label: 'Photo', aspect: 'vertical', maxVideoSeconds: 0, acceptsImage: true, acceptsVideo: false },
    ],
    requiresMessageTemplate: false,
  },
  youtube: {
    network: 'youtube',
    label: 'YouTube',
    text: { maxChars: 5000, maxImages: 1, maxVideos: 1, requiresMedia: true },
    media: { maxImageBytes: 2 * MB, maxVideoBytes: 256 * GB, videoFormats: ['mp4', 'mov', 'avi'] },
    rateLimit: { windowSeconds: 86_400, maxPublishes: 6 },
    features: { nativeScheduling: false, twoStepPublish: true, metrics: true, commentReply: true },
    contentTypes: [
      { id: 'video', label: 'Video', aspect: 'landscape', maxVideoSeconds: 43_200, acceptsImage: false, acceptsVideo: true },
      { id: 'short', label: 'Short', aspect: 'vertical', maxVideoSeconds: 180, acceptsImage: false, acceptsVideo: true },
    ],
    requiresMessageTemplate: false,
  },
  x: {
    network: 'x',
    label: 'X',
    text: { maxChars: 280, maxImages: 4, maxVideos: 1, requiresMedia: false },
    media: { maxImageBytes: 5 * MB, maxVideoBytes: 512 * MB, videoFormats: ['mp4', 'mov'] },
    rateLimit: { windowSeconds: 86_400, maxPublishes: 1_000 },
    features: { nativeScheduling: false, twoStepPublish: false, metrics: true, commentReply: true },
    contentTypes: [
      { id: 'post', label: 'Post', aspect: 'any', maxVideoSeconds: 140, acceptsImage: true, acceptsVideo: true },
    ],
    requiresMessageTemplate: false,
  },
  telegram: {
    network: 'telegram',
    label: 'Telegram',
    text: { maxChars: 4096, maxImages: 10, maxVideos: 1, requiresMedia: false },
    media: { maxImageBytes: 10 * MB, maxVideoBytes: 50 * MB, videoFormats: ['mp4', 'mov'] },
    rateLimit: { windowSeconds: 60, maxPublishes: 30 },
    features: { nativeScheduling: false, twoStepPublish: false, metrics: false, commentReply: false },
    contentTypes: [
      { id: 'message', label: 'Mensagem', aspect: 'any', maxVideoSeconds: 1800, acceptsImage: true, acceptsVideo: true },
    ],
    requiresMessageTemplate: false,
  },
  whatsapp: {
    network: 'whatsapp',
    label: 'WhatsApp',
    text: { maxChars: 4096, maxImages: 1, maxVideos: 1, requiresMedia: false },
    media: { maxImageBytes: 16 * MB, maxVideoBytes: 16 * MB, videoFormats: ['mp4', '3gp'] },
    rateLimit: { windowSeconds: 86_400, maxPublishes: 1_000 },
    features: { nativeScheduling: false, twoStepPublish: false, metrics: false, commentReply: false },
    contentTypes: [
      { id: 'template', label: 'Template aprovado', aspect: 'any', maxVideoSeconds: 0, acceptsImage: true, acceptsVideo: true },
    ],
    requiresMessageTemplate: true,
  },
};

export const isNetwork = (value: string): value is Network => value in NETWORK_SPECS;
