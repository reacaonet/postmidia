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
export type CampaignInput = Omit<Campaign, 'id' | 'createdAt'>;export type PostInput = Omit<Post, 'id' | 'createdAt'>;
// `releaseIdMissing` fica de fora de proposito: um job recem-criado nunca esta
// pendente de reconciliacao. O campo so faz sentido depois que o provedor
// aceitou a publicacao, e quem o escreve e o worker, no patch do sucesso.
export type JobInput = Omit<
  PublishJob,
  'id' | 'createdAt' | 'updatedAt' | 'releaseIdMissing' | 'publishedAt'
>;
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

/** Volume de uma rede dentro da janela observada. */
export interface NetworkVolume {
  network: string;
  total: number;
  succeeded: number;
  failed: number;
  /** `failed / total`, arredondado a 4 casas; `null` quando nao houve volume. */
  failureRate: number | null;
}

/**
 * Latencia de publicacao, do agendamento ao sucesso, em segundos.
 *
 * Mede `published_at - scheduled_at`, que inclui a espera na fila e o backoff de
 * retentativas. Nao e a latencia da chamada HTTP ao provedor, e nao deve ser lida
 * como tal: e o tempo que o usuario esperou para o post aparecer.
 */
export interface PublishLatency {
  samples: number;
  p50Seconds: number | null;
  p95Seconds: number | null;
  maxSeconds: number | null;
}

export interface OpsMetrics {
  /** Janela observada, de `created_at` ate agora. */
  windowHours: number;
  generatedAt: string;
  /** Estado atual da fila, sem recorte: e o que o operador precisa ver primeiro. */
  byStatus: Record<string, number>;
  /** Volume por rede dentro da janela. */
  byNetwork: NetworkVolume[];
  latency: PublishLatency;
  /** Jobs publicados que ainda aguardam o id do provedor. */
  pendingReconciliation: number;
  /** Entradas de fila morta em aberto, aguardando triagem. */
  openDeadLetters: number;
  /** `null` quando a leitura e de sistema; preenchido na visao por tenant. */
  tenantId?: string | null;
  tenantName?: string | null;
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
  /**
   * Leitura CRUZ de e-mail, sem tenant, para o login sem slug.
   *
   * `UNIQUE (tenant_id, email)` permite o mesmo e-mail em empresas diferentes,
   * entao um e-mail pode resolver para mais de um usuario. A lista vem com todos
   * os candidatos e quem chama decide: o login verifica a senha contra cada um e
   * so entra no que casar.
   *
   * E leitura de SISTEMA de proposito, como `getTenantBySlug`: antes do token nao
   * existe contexto de tenant para o RLS restricting. O risco e' a superficie —
   * a funcao so aceita um e-mail exato e devolve o registro inteiro, entao quem
   * chama precisa continuar sendo o login.
   */
  findUsersByEmail(email: string): Promise<User[]>;
  findUserById(tenantId: string, id: string): Promise<User | undefined>;

  appendAudit(input: Omit<AuditEntry, 'id' | 'createdAt'>): Promise<void>;
  listAudit(tenantId: string, limit?: number): Promise<AuditEntry[]>;

  insertAccount(input: AccountInput): Promise<ChannelAccount>;
  listAccounts(tenantId: string): Promise<ChannelAccount[]>;
  getAccount(tenantId: string, id: string): Promise<ChannelAccount | undefined>;
  /**
   * Edita os campos que o operador corrige sem refazer a conexao. `secret` e
   * opcional de proposito: trocar o token da rede e uma operacao diferente de
   * arrumar um `@` duplicado no identificador, e quem chama decide o que mandou.
   *
   * `status` tambem e do chamador, e nao derivado aqui: quem sabe se a rede tem
   * um provedor que valida o token o qual(validacao) nao e a camada de storage.
   * Redes com bridge voltam para `pending` ate o sync confirmar o token novo;
   * redes nativas nao tem sync que as liberte, entao elas recebem `active` --
   * senao a conta ficaria impedida de publicar para sempre, ja que `pending`
   * bloqueia o publish e nao existe caminho de volta.
   */
  updateAccount(
    tenantId: string,
    id: string,
    changes: {
      displayName?: string;
      externalAccountId?: string;
      encryptedSecret?: string;
      status?: ChannelAccountStatus;
    }
  ): Promise<ChannelAccount | undefined>;
  /** Apaga a conta do tenant. Devolve `false` se o id nao existe neste tenant. */
  deleteAccount(tenantId: string, id: string): Promise<boolean>;
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
   * Jobs de qualquer tenant que publicaram mas ainda nao tem o id do provedor.
   *
   * E de sistema, nao de tenant: a reconciliacao e tarefa de infra. A leitura
   * atravessa o RLS de proposito (o worker nao pertence a um tenant), mas cada
   * job so e reconciliado em nome da conta que o proprio job referencia.
   * Ordenado por `updated_at` para que o mais antigo nao fique para tras
   * quando houver mais pendentes que o limite do lote.
   */
  listJobsPendingReconciliation(limit: number): Promise<PublishJob[]>;

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

  /**
   * Painel operacional da instalacao inteira, e nao de um tenant.
   *
   * Por isso leitura de sistema (`withSystem`, so SELECT): sao numeros que
   * atravessam tenants, e quem pode ver e a operacao -- nao qualquer owner de
   * tenant, que e um papel por tenant e nao um papel de plataforma.
   */
  getOpsMetrics(windowHours: number): Promise<OpsMetrics>;
  /** Mesma leitura, restrita a um tenant. */
  getTenantOpsMetrics(tenantId: string, windowHours: number): Promise<OpsMetrics>;

  close(): Promise<void>;
}
