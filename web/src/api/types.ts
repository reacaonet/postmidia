/**
 * Contrato da API, espelhando src/domain/types.ts e as rotas.
 *
 * Os campos vem de leitura literal do backend, nao de memoria. Onde o backend
 * expoe algo que nao parece nome de campo (por exemplo `settings` que e um
 * `Record<string, unknown>` livre), o tipo aqui e deliberadamente aberto e a
 * validacao real acontece no servidor — inventar um tipo detalhado para
 * `settings` criaria a ilusao de que o painel valida algo que so o backend
 * valida.
 */

export type Network =
  | 'instagram'
  | 'facebook'
  | 'linkedin'
  | 'tiktok'
  | 'youtube'
  | 'x'
  | 'telegram'
  | 'whatsapp';

export type Role = 'owner' | 'admin' | 'member';

export type AccountStatus = 'pending' | 'active' | 'expired' | 'revoked' | 'error';

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export type TemplateStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'PAUSED' | 'DISABLED';

export type TemplateCategory = 'MARKETING' | 'UTILITY' | 'AUTHENTICATION';

export type TemplateHeaderType = 'NONE' | 'TEXT' | 'IMAGE' | 'VIDEO' | 'DOCUMENT';

export type DeadLetterResolution = 'requeued' | 'discarded';

/** Envelope de sucesso. `data` muda de forma conforme a rota — ver `ApiError`. */
export interface ApiOk<T> {
  success: true;
  data: T;
}

export interface PublicUser {
  id: string;
  tenantId: string;
  email: string;
  role: Role;
  status: 'active' | 'disabled';
  createdAt: string;
}

export interface TenantRef {
  id: string;
  name: string;
  slug: string;
}

export interface ChannelAccount {
  id: string;
  tenantId: string;
  network: Network;
  externalAccountId: string;
  displayName: string;
  scopes: string[];
  status: AccountStatus;
  tokenExpiresAt: string | null;
  /** null = nunca sincronizado. Tem precedencia sobre `NETWORK_SPECS`. */
  providerMaxLength: number | null;
  providerRules: string | null;
  specsSyncedAt: string | null;
  createdAt: string;
}

export interface Campaign {
  id: string;
  tenantId: string;
  name: string;
  status: 'draft' | 'scheduled' | 'running' | 'finished' | 'cancelled';
  createdAt: string;
}

export interface MediaItem {
  kind: 'image' | 'video';
  url: string;
  /** O servidor preenche o que faltar (Fase 8). Pode vir preenchido sem ter sido enviado. */
  bytes?: number;
  mimeType?: string;
  durationSeconds?: number;
  width?: number;
  height?: number;
}

export interface PublishJob {
  id: string;
  tenantId: string;
  postId: string;
  channelAccountId: string;
  network: Network;
  recipient: string | null;
  status: JobStatus;
  scheduledAt: string;
  attempts: number;
  /**
   * Enquanto `releaseIdMissing === true`, isto e o id INTERNO do Postiz, nao o
   * id da rede. Nao montar link com ele enquanto a flag estiver ligada.
   */
  externalPostId: string | null;
  permalink: string | null;
  releaseIdMissing: boolean;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
}

export interface JobWithAccount extends PublishJob {
  account: ChannelAccount;
}

export interface WhatsappTemplate {
  id: string;
  tenantId: string;
  name: string;
  languageCode: string;
  category: TemplateCategory;
  status: TemplateStatus;
  headerType: TemplateHeaderType;
  variableCount: number;
  createdAt: string;
}

export interface DeadLetterJob {
  id: string;
  tenantId: string;
  jobId: string;
  postId: string;
  channelAccountId: string;
  network: Network;
  recipient: string | null;
  attempts: number;
  lastError: string | null;
  /** Unico campo da API com cara de codigo de erro que nao vive no envelope. */
  lastErrorCode: string | null;
  /** null = ainda aberta. */
  resolution: DeadLetterResolution | null;
  resolvedAt: string | null;
  requeueCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface AuditEntry {
  id: string;
  tenantId: string;
  actorUserId: string | null;
  actorEmail: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface NetworkContentType {
  id: string;
  label: string;
  aspect: string;
  maxVideoSeconds: number | null;
  acceptsImage: boolean;
  acceptsVideo: boolean;
}

export interface NetworkSpec {
  network: Network;
  label: string;
  text: { maxChars: number; maxImages: number; maxVideos: number; requiresMedia: boolean };
  media: { maxImageBytes: number; maxVideoBytes: number; videoFormats: string[] };
  rateLimit: { windowSeconds: number; maxPublishes: number };
  features: {
    nativeScheduling: boolean;
    twoStepPublish: boolean;
    metrics: boolean;
    commentReply: boolean;
  };
  contentTypes: NetworkContentType[];
  requiresMessageTemplate: boolean;
}

export interface NetworksResponse {
  registered: Network[];
  bridgedViaPostiz: Network[];
  specs: Record<Network, NetworkSpec>;
}

export interface CapabilityEntry {
  network: Network;
  label: string;
  capabilities: NetworkSpec['features'];
}

export interface ValidationIssue {
  field: 'text' | 'media' | 'contentType' | 'account';
  code: string;
  message: string;
}

/** Uma entrada do `data` do 422 de `POST /campaigns/:id/posts`. */
export interface RejectionGroup {
  accountId: string;
  network: Network;
  issues: ValidationIssue[];
}

export interface CreatePostResult {
  post: {
    id: string;
    tenantId: string;
    campaignId: string;
    contentType: string;
    text: string;
    media: MediaItem[];
    settings: Record<string, unknown>;
    createdAt: string;
  };
  scheduledAt: string;
  jobs: JobWithAccount[];
}

export interface ReconcileResult {
  /** 'pending' chega com HTTP 202 e success:true — nao e erro. */
  outcome: 'reconciled' | 'pending';
  externalPostId: string | null;
  permalink: string | null;
}

export interface QuotaBucket {
  bucket: 'posts' | 'uploads';
  used: number;
  limit: number;
  remaining: number;
  ratio: number;
  state: 'ok' | 'warning' | 'exhausted';
  /** false = sem Redis; contador em memoria. Cenario normal, nao erro. */
  tracked: boolean;
}

export interface OpsMetrics {
  windowHours: number;
  generatedAt: string;
  byStatus: Record<string, number>;
  byNetwork: Array<{
    network: Network;
    total: number;
    succeeded: number;
    failed: number;
    failureRate: number | null;
  }>;
  latency: {
    samples: number;
    p50Seconds: number | null;
    p95Seconds: number | null;
    maxSeconds: number | null;
  };
  pendingReconciliation: number;
  openDeadLetters: number;
  tenantId?: string | null;
  tenantName?: string | null;
  postizQuota: QuotaBucket[];
  alerts: { postizQuota: 'ok' | 'warning' | 'exhausted'; blocking: boolean };
}

export interface AccountSettingsNative {
  network: Network;
  native: true;
  fallbackMaxLength: number;
  cached: { maxLength: number | null; rules: string | null; syncedAt: string | null };
}

export interface AccountSettingsBridged {
  network: Network;
  native: false;
  cached: { maxLength: number | null; rules: string | null; syncedAt: string | null };
  rules: string | null;
  maxLength: number | null;
  /** Schema de configuracao do Postiz — deliberadamente `unknown`. */
  settings: unknown;
  tools: Array<{ methodName: string; description?: string }>;
}

export type AccountSettings = AccountSettingsNative | AccountSettingsBridged;
