import type {
  AuditEntry,
  Campaign,
  ChannelAccount,
  ChannelAccountStatus,
  DeadLetterJob,
  DeadLetterResolution,
  Post,
  PublishJob,
  PublishJobStatus,
  Tenant,
  User,
  WhatsappTemplate,
  WhatsappTemplateStatus,
} from '../domain/types';

// providerMaxLength/providerRules/specsSyncedAt ficam de fora: quem preenche e o
// sync de specs (Fase 7), nao quem cria a conta. Assim toda conta nasce
// explicitamente nao sincronizada e cai no NETWORK_SPECS ate o primeiro sync.
export type AccountInput = Omit<
  ChannelAccount,
  'id' | 'createdAt' | 'providerMaxLength' | 'providerRules' | 'specsSyncedAt'
>;
export type CampaignInput = Omit<Campaign, 'id' | 'createdAt'>;
export type PostInput = Omit<Post, 'id' | 'createdAt'>;
export type JobInput = Omit<PublishJob, 'id' | 'createdAt' | 'updatedAt'>;
export type TemplateInput = Omit<WhatsappTemplate, 'id' | 'createdAt'>;

export interface JobFilter {
  status?: PublishJobStatus;
  campaignId?: string;
}

export interface DeadLetterFilter {
  /** Ausente traz tanto as abertas quanto as ja resolvidas. */
  resolution?: DeadLetterResolution | 'open';
  limit?: number;
}

/** Limites autoritativos lidos do provedor (Fase 7). */
export interface ProviderSpec {
  /** Limite de caracteres do provedor; null quando ele nao informa. */
  maxLength: number | null;
  /** Texto de regras do provedor. Guardado para consulta, nao validado. */
  rules: string | null;
}

export interface Store {
  createTenant(input: { name: string; slug: string }): Promise<Tenant>;
  getTenant(id: string): Promise<Tenant | undefined>;
  getTenantBySlug(slug: string): Promise<Tenant | undefined>;
  listTenants(): Promise<Tenant[]>;

  insertUser(input: {
    tenantId: string;
    email: string;
    passwordHash: string;
    role: string;
  }): Promise<User>;
  findUserByEmail(tenantId: string, email: string): Promise<User | undefined>;
  findUserById(tenantId: string, id: string): Promise<User | undefined>;

  appendAudit(input: Omit<AuditEntry, 'id' | 'createdAt'>): Promise<void>;
  listAudit(tenantId: string, limit?: number): Promise<AuditEntry[]>;

  insertAccount(input: AccountInput): Promise<ChannelAccount>;
  listAccounts(tenantId: string): Promise<ChannelAccount[]>;
  getAccount(tenantId: string, id: string): Promise<ChannelAccount | undefined>;
  updateAccountStatus(
    tenantId: string,
    id: string,
    status: ChannelAccountStatus
  ): Promise<ChannelAccount | undefined>;
  updateAccountProviderSpec(
    tenantId: string,
    id: string,
    spec: ProviderSpec
  ): Promise<ChannelAccount | undefined>;

  insertCampaign(input: CampaignInput): Promise<Campaign>;
  listCampaigns(tenantId: string): Promise<Campaign[]>;
  getCampaign(tenantId: string, id: string): Promise<Campaign | undefined>;

  insertPost(input: PostInput): Promise<Post>;
  getPost(tenantId: string, id: string): Promise<Post | undefined>;

  insertJob(input: JobInput): Promise<PublishJob>;
  getJob(tenantId: string, id: string): Promise<PublishJob | undefined>;
  patchJob(tenantId: string, id: string, patch: Partial<PublishJob>): Promise<PublishJob | undefined>;
  listJobs(tenantId: string, filter?: JobFilter): Promise<PublishJob[]>;

  /**
   * Coloca o job na fila morta. Idempotente por `jobId`: um novo dead-letter do
   * mesmo job reabre a entrada existente em vez de criar uma segunda, para o
   * operador nao ver o mesmo erro repetido como se fossem ocorrencias distintas.
   *
   * Devolve `undefined` se o job nao existir mais (pode ter sido apagado em
   * cascata junto com o post). Quem chama trata como nao-falha: nao ha o que
   * dead-letterar.
   */
  upsertDeadLetter(input: {
    tenantId: string;
    jobId: string;
    attempts: number;
    lastError: string | null;
    lastErrorCode: string | null;
  }): Promise<DeadLetterJob | undefined>;
  listDeadLetters(tenantId: string, filter?: DeadLetterFilter): Promise<DeadLetterJob[]>;
  getDeadLetter(tenantId: string, id: string): Promise<DeadLetterJob | undefined>;
  /**
   * `requeued` soma em requeue_count e fecha a entrada; `discarded` tambem
   * fecha, sem incrementar. Nao reabre: a tabela nao tem DELETE justamente
   * porque fila morta e registro.
   */
  resolveDeadLetter(
    tenantId: string,
    id: string,
    resolution: DeadLetterResolution
  ): Promise<DeadLetterJob | undefined>;

  insertTemplate(input: TemplateInput): Promise<WhatsappTemplate>;
  listTemplates(tenantId: string): Promise<WhatsappTemplate[]>;
  findTemplate(tenantId: string, name: string, languageCode: string): Promise<WhatsappTemplate | undefined>;
  updateTemplateStatus(
    tenantId: string,
    id: string,
    status: WhatsappTemplateStatus
  ): Promise<WhatsappTemplate | undefined>;

  close(): Promise<void>;
}
