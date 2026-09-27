import type { MediaKind, Network } from './networks';

export interface Tenant {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
}

export type ChannelAccountStatus = 'pending' | 'active' | 'expired' | 'revoked' | 'error';

export interface ChannelAccount {
  id: string;
  tenantId: string;
  network: Network;
  externalAccountId: string;
  displayName: string;
  encryptedSecret: string;
  scopes: string[];
  status: ChannelAccountStatus;
  tokenExpiresAt: string | null;
  // Fase 7: limites vindos do provedor. `providerMaxLength` e null enquanto a
  // conta nunca foi sincronizada, e nesse caso a validacao usa NETWORK_SPECS.
  providerMaxLength: number | null;
  providerRules: string | null;
  specsSyncedAt: string | null;
  createdAt: string;
}

export type PublicChannelAccount = Omit<ChannelAccount, 'encryptedSecret'>;

export type ResolvedChannelAccount = Omit<ChannelAccount, 'encryptedSecret'> & { secret: string };

export interface MediaRef {
  kind: MediaKind;
  url: string;
  bytes?: number;
  durationSeconds?: number;
  mimeType?: string;
  width?: number;
  height?: number;
}

export interface Campaign {
  id: string;
  tenantId: string;
  name: string;
  status: 'draft' | 'scheduled' | 'running' | 'finished' | 'cancelled';
  createdAt: string;
}

export interface Post {
  id: string;
  tenantId: string;
  campaignId: string;
  contentType: string;
  text: string;
  media: MediaRef[];
  settings: Record<string, unknown>;
  createdAt: string;
}

export type PublishJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

/**
 * Como a fila morta foi tratada. `null` e o estado aberto: ninguem agiu ainda.
 * `discarded` e uma decisao do operador, nao um sucesso.
 */
export type DeadLetterResolution = 'requeued' | 'discarded';

/**
 * Job que esgotou as tentativas ainda sendo retentavel (Fase 9). So entra aqui
 * o que ainda pode dar certo numa reexecucao: falha nao retentavel e terminal
 * por definicao e nao entra.
 */
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
  lastErrorCode: string | null;
  resolution: DeadLetterResolution | null;
  resolvedAt: string | null;
  requeueCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface PublishJob {
  id: string;
  tenantId: string;
  postId: string;
  channelAccountId: string;
  network: Network;
  recipient: string | null;
  status: PublishJobStatus;
  scheduledAt: string;
  attempts: number;
  /**
   * Enquanto `releaseIdMissing` for true, isto e o id INTERNO do Postiz, e nao
   * o id da rede. A reconciliacao usa esse id para pedir o id verdadeiro ao
   * Postiz; so depois de reconciliado o campo passa a ser o id da rede.
   */
  externalPostId: string | null;
  permalink: string | null;
  /** Publicacao aceita, mas o provedor ainda nao devolveu o id do post. */
  releaseIdMissing: boolean;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PostMetrics {
  externalPostId: string;
  impressions: number | null;
  engagements: number | null;
  clicks: number | null;
  fetchedAt: string;
}

export type UserRole = 'owner' | 'admin' | 'member';

export interface User {
  id: string;
  tenantId: string;
  email: string;
  passwordHash: string;
  role: UserRole;
  status: 'active' | 'disabled';
  createdAt: string;
}

export type PublicUser = Omit<User, 'passwordHash'>;

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

export type WhatsappTemplateStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'PAUSED' | 'DISABLED';
export type WhatsappHeaderType = 'NONE' | 'TEXT' | 'IMAGE' | 'VIDEO' | 'DOCUMENT';

export interface WhatsappTemplate {
  id: string;
  tenantId: string;
  name: string;
  languageCode: string;
  category: 'MARKETING' | 'UTILITY' | 'AUTHENTICATION';
  status: WhatsappTemplateStatus;
  headerType: WhatsappHeaderType;
  variableCount: number;
  createdAt: string;
}
