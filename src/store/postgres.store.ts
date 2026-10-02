import type { PoolClient } from 'pg';
import type {
  AuditEntry,
  Campaign,
  ChannelAccount,
  DeadLetterJob,
  Post,
  PublishJob,
  Tenant,
  User,
  WhatsappTemplate,
} from '../domain/types';
import { closePool, withSystem, withTenant } from '../db/pool';
import type {
  AccountInput,
  CampaignInput,
  DeadLetterFilter,
  OpsMetrics,
  JobInput,
  PostInput,
  Store,
  TemplateInput,
} from './types';

type Row = Record<string, unknown>;

const iso = (value: unknown): string =>
  value instanceof Date ? value.toISOString() : String(value);

const isoOrNull = (value: unknown): string | null => (value == null ? null : iso(value));

const tenantIdOf = (row: Row): string => String(row.tenant_id);

const mapTenant = (row: Row): Tenant => ({
  id: String(row.id),
  name: String(row.name),
  slug: String(row.slug),
  createdAt: iso(row.created_at),
});

const mapAccount = (row: Row): ChannelAccount => ({
  id: String(row.id),
  tenantId: tenantIdOf(row),
  network: row.network as ChannelAccount['network'],
  externalAccountId: String(row.external_account_id),
  displayName: String(row.display_name),
  encryptedSecret: String(row.encrypted_secret),
  scopes: (row.scopes as string[]) ?? [],
  status: row.status as ChannelAccount['status'],
  tokenExpiresAt: isoOrNull(row.token_expires_at),
  // provider_max_length pode chegar como string se o driver mudar, entao o
  // Number() vai antes de comparar: Number(null) seria 0 e reprovaria todo
  // post com texto nao vazio.
  providerMaxLength: row.provider_max_length == null ? null : Number(row.provider_max_length),
  providerRules: row.provider_rules == null ? null : String(row.provider_rules),
  specsSyncedAt: isoOrNull(row.specs_synced_at),
  createdAt: iso(row.created_at),
});

const mapCampaign = (row: Row): Campaign => ({
  id: String(row.id),
  tenantId: tenantIdOf(row),
  name: String(row.name),
  status: row.status as Campaign['status'],
  createdAt: iso(row.created_at),
});

const mapPost = (row: Row): Post => ({
  id: String(row.id),
  tenantId: tenantIdOf(row),
  campaignId: String(row.campaign_id),
  contentType: String(row.content_type),
  text: String(row.text),
  media: (row.media as Post['media']) ?? [],
  settings: (row.settings as Post['settings']) ?? {},
  createdAt: iso(row.created_at),
});

const mapJob = (row: Row): PublishJob => ({
  id: String(row.id),
  tenantId: tenantIdOf(row),
  postId: String(row.post_id),
  channelAccountId: String(row.channel_account_id),
  network: row.network as PublishJob['network'],
  recipient: row.recipient == null ? null : String(row.recipient),
  status: row.status as PublishJob['status'],
  scheduledAt: iso(row.scheduled_at),
  attempts: Number(row.attempts),
  externalPostId: row.external_post_id == null ? null : String(row.external_post_id),
  permalink: row.permalink == null ? null : String(row.permalink),
  releaseIdMissing: row.release_id_missing === true,
  lastError: row.last_error == null ? null : String(row.last_error),
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at),
  publishedAt: isoOrNull(row.published_at),
});

const mapDeadLetter = (row: Row): DeadLetterJob => ({
  id: String(row.id),
  tenantId: tenantIdOf(row),
  jobId: String(row.job_id),
  postId: String(row.post_id),
  channelAccountId: String(row.channel_account_id),
  network: row.network as DeadLetterJob['network'],
  recipient: row.recipient == null ? null : String(row.recipient),
  attempts: Number(row.attempts),
  lastError: row.last_error == null ? null : String(row.last_error),
  lastErrorCode: row.last_error_code == null ? null : String(row.last_error_code),
  resolution: (row.resolution ?? null) as DeadLetterJob['resolution'],
  resolvedAt: isoOrNull(row.resolved_at),
  requeueCount: Number(row.requeue_count),
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at),
});

const mapTemplate = (row: Row): WhatsappTemplate => ({
  id: String(row.id),
  tenantId: tenantIdOf(row),
  name: String(row.name),
  languageCode: String(row.language_code),
  category: row.category as WhatsappTemplate['category'],
  status: row.status as WhatsappTemplate['status'],
  headerType: row.header_type as WhatsappTemplate['headerType'],
  variableCount: Number(row.variable_count),
  createdAt: iso(row.created_at),
});

const mapUser = (row: Row): User => ({
  id: String(row.id),
  tenantId: tenantIdOf(row),
  email: String(row.email),
  passwordHash: String(row.password_hash),
  role: row.role as User['role'],
  status: row.status as User['status'],
  createdAt: iso(row.created_at),
});

const mapAudit = (row: Row): AuditEntry => ({
  id: String(row.id),
  tenantId: tenantIdOf(row),
  actorUserId: row.actor_user_id == null ? null : String(row.actor_user_id),
  actorEmail: row.actor_email == null ? null : String(row.actor_email),
  action: String(row.action),
  entityType: String(row.entity_type),
  entityId: row.entity_id == null ? null : String(row.entity_id),
  metadata: (row.metadata as Record<string, unknown>) ?? {},
  createdAt: iso(row.created_at),
});

const first = <T>(result: { rows: Row[] }, mapper: (row: Row) => T): T | undefined =>
  result.rows[0] ? mapper(result.rows[0]) : undefined;

/**
 * Le as metricas do painel operacional.
 *
 * O mesmo corpo serve a visao de sistema e a visao por tenant: o que muda e o
 * `runner` (com `withSystem` ou `withTenant`) e o filtro opcional de tenant. Uma
 * implementacao so, para as duas nao divergirem com o tempo -- dois codigos
 * parecendo iguais que medem coisas diferentes e o modo classico de metricas que
 * ninguem mais pode confiar.
 *
 * As cinco consultas sao separadas de proposito, e nao uma unica com JOINs: cada
 * uma e uma leitura diferente, e um JOIN multiplicaria linhas e quebraria as
 * contagens. A janela entra por parametro no SQL, nunca interpolada.
 */
const readOpsMetrics = async (
  runner: <T>(fn: (client: PoolClient) => Promise<T>) => Promise<T>,
  windowHours: number,
  tenantId: string | null
): Promise<OpsMetrics> => {
  const hours = Math.max(1, Math.min(Math.floor(windowHours) || 24, 24 * 30));
  // Quando ha tenant, ele e $1 e as horas sao $2; sem tenant, as horas viram $1.
  // A janela entra sempre como parametro, nunca interpolada no texto.
  const params: unknown[] = tenantId ? [tenantId, hours] : [hours];
  const hoursPlaceholder = tenantId ? '$2' : '$1';
  const windowClause = `created_at > now() - (${hoursPlaceholder} || ' hours')::interval`;
  const volumeWhere = tenantId ? `tenant_id = $1 AND ${windowClause}` : windowClause;
  const tenantScope = tenantId ? 'WHERE tenant_id = $1' : '';
  const currentWhere = tenantId ? 'WHERE tenant_id = $1 AND' : 'WHERE';
  const tenantParams: unknown[] = tenantId ? [tenantId] : [];

  const data = await runner(async (client) => {
      // `byStatus` NAO usa `volumeWhere`, e a distincao e deliberada: e o estado
      // ATUAL da fila, nao o movimento do periodo. Um job travado ha tres dias
      // continua sendo trabalho pendente hoje, e um painel que o escondesse depois
      // do corte daria a impressao de fila vazia. O volume por rede, esse sim, e
      // recorte -- sao registros de atividade, nao de estoque.
      const byStatusResult = await client.query<{ status: string; total: string }>(
        `SELECT status, COUNT(*)::text AS total FROM publish_jobs
          ${tenantScope} GROUP BY status`,
        tenantParams
      );

      const byNetworkResult = await client.query<{
        network: string;
        total: string;
        succeeded: string;
        failed: string;
      }>(
        `SELECT network,
                COUNT(*)::text AS total,
                COUNT(*) FILTER (WHERE status = 'succeeded')::text AS succeeded,
                COUNT(*) FILTER (WHERE status = 'failed')::text AS failed
           FROM publish_jobs
          WHERE ${volumeWhere}
          GROUP BY network
          ORDER BY COUNT(*) DESC, network`,
        params
      );

      // `percentile_cont` sobre o intervalo de publicacao, em segundos. Filtra
      // por `published_at IS NOT NULL` porque so o sucesso o preenche; sem o
      // filtro, os jobs nunca publicados entrariam com NULL e o percentil os
      // ignoraria em silencio.
      const latencyResult = await client.query<{
        samples: string;
        p50: string | null;
        p95: string | null;
        max: string | null;
      }>(
        `SELECT COUNT(*)::text AS samples,
                percentile_cont(0.5) WITHIN GROUP (
                  ORDER BY EXTRACT(EPOCH FROM (published_at - scheduled_at))
                )::text AS p50,
                percentile_cont(0.95) WITHIN GROUP (
                  ORDER BY EXTRACT(EPOCH FROM (published_at - scheduled_at))
                )::text AS p95,
                MAX(EXTRACT(EPOCH FROM (published_at - scheduled_at)))::text AS max
           FROM publish_jobs
          WHERE ${volumeWhere}
            AND published_at IS NOT NULL
            AND status = 'succeeded'`,
        params
      );

      // Estas tres nao usam a janela de volume: sao o estado atual da fila, e um
      // job travado ha tres dias continua sendo trabalho pendente hoje.
      const reconciliationResult = await client.query<{ total: string }>(
        `SELECT COUNT(*)::text AS total FROM publish_jobs
          ${currentWhere} release_id_missing`,
        tenantParams
      );

      const deadLetterResult = await client.query<{ total: string }>(
        `SELECT COUNT(*)::text AS total FROM dead_letter_jobs
          ${currentWhere} resolution IS NULL`,
        tenantParams
      );

      const tenantResult = tenantId
        ? await client.query<{ name: string }>('SELECT name FROM tenants WHERE id = $1', [tenantId])
        : { rows: [] as { name: string }[] };

      return {
        byStatus: byStatusResult.rows,
        byNetwork: byNetworkResult.rows,
        latency: latencyResult.rows[0] ?? { samples: '0', p50: null, p95: null, max: null },
        reconciliation: reconciliationResult.rows[0]?.total ?? '0',
        deadLetters: deadLetterResult.rows[0]?.total ?? '0',
        tenantName: tenantResult.rows[0]?.name ?? null,
      };
    }
  );

  const toNumber = (value: string | null | undefined): number | null => {
    if (value === null || value === undefined) {
      return null;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };

  return {
    windowHours: hours,
    generatedAt: new Date().toISOString(),
    byStatus: Object.fromEntries(data.byStatus.map((row) => [row.status, Number(row.total)])),
    byNetwork: data.byNetwork.map((row) => {
      const total = Number(row.total);
      const failed = Number(row.failed);
      return {
        network: row.network,
        total,
        succeeded: Number(row.succeeded),
        failed,
        failureRate: total > 0 ? Math.round((failed / total) * 10_000) / 10_000 : null,
      };
    }),
    latency: {
      samples: Number(data.latency.samples),
      p50Seconds: toNumber(data.latency.p50),
      p95Seconds: toNumber(data.latency.p95),
      maxSeconds: toNumber(data.latency.max),
    },
    pendingReconciliation: Number(data.reconciliation),
    openDeadLetters: Number(data.deadLetters),
    tenantId,
    tenantName: data.tenantName,
  };
};

export const createPostgresStore = (): Store => ({
  /**
   * Jobs de todos os tenants que ainda nao receberam o id do provedor.
   *
   * Usa `withSystem` de proposito: a reconciliacao e uma tarefa de infra, nao
   * uma acao de tenant, e precisa enxergar o backlog inteiro. A leitura e
   * autorizada pela policy `system_read_publish_jobs` (FOR SELECT). A gravacao
   * do id reconciliado nao passa por aqui, e sim por `withTenant(job.tenantId)`:
   * o papel da aplicacao nao tem BYPASSRLS e nenhuma policy deste esquema
   * autoriza `withSystem` a ESCREVER em nome de um tenant. Ler em todos os
   * tenants e escrever em todos os tenants sao permissoes distintas de proposito.
   *
   * Alem disso, a operacao nao aceita tenant de quem chama: ela le os jobs,
   * chama o Postiz em nome da CONTA que o job referencia e devolve o id do
   * provedor. Nenhum dado de um tenant e exposto a outro: quem chama e o worker.
   */
  listJobsPendingReconciliation: (limit) =>
    withSystem(async (client) => {
      const result = await client.query(
        `SELECT * FROM publish_jobs
          WHERE release_id_missing
          ORDER BY updated_at
          LIMIT $1`,
        [limit]
      );
      return result.rows.map(mapJob);
    }),

  getOpsMetrics: (windowHours) => readOpsMetrics((fn) => withSystem(fn), windowHours, null),
  getTenantOpsMetrics: (tenantId, windowHours) =>
    readOpsMetrics((fn) => withTenant(tenantId, fn), windowHours, tenantId),

  createTenant: (input) =>
    withSystem(async (client) => {
      const result = await client.query(
        'INSERT INTO tenants (name, slug) VALUES ($1, $2) RETURNING *',
        [input.name, input.slug]
      );
      return mapTenant(result.rows[0]);
    }),

  getTenant: (id) =>
    withSystem(async (client) => {
      const result = await client.query('SELECT * FROM tenants WHERE id = $1', [id]);
      return first(result, mapTenant);
    }),

  getTenantBySlug: (slug) =>
    withSystem(async (client) => {
      const result = await client.query('SELECT * FROM tenants WHERE slug = $1', [slug]);
      return first(result, mapTenant);
    }),

  insertUser: (input) =>
    withTenant(input.tenantId, async (client) => {
      const result = await client.query(
        `INSERT INTO users (tenant_id, email, password_hash, role, status)
         VALUES ($1, $2, $3, $4, 'active')
         RETURNING *`,
        [input.tenantId, input.email.toLowerCase(), input.passwordHash, input.role]
      );
      return mapUser(result.rows[0]);
    }),

  findUserByEmail: (tenantId, email) =>
    withTenant(tenantId, async (client) => {
      const result = await client.query(
        'SELECT * FROM users WHERE tenant_id = $1 AND email = $2 LIMIT 1',
        [tenantId, email.toLowerCase()]
      );
      return first(result, mapUser);
    }),

  // Ver `findUsersByEmail` em store/types.ts: a lista completa de candidatos e o
  // que permite login sem slug sem decidir nada aqui.
  findUsersByEmail: (email) =>
    withSystem(async (client) => {
      const result = await client.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
      return result.rows.map(mapUser);
    }),

  findUserById: (tenantId, id) =>
    withTenant(tenantId, async (client) => {
      const result = await client.query(
        'SELECT * FROM users WHERE tenant_id = $1 AND id = $2 LIMIT 1',
        [tenantId, id]
      );
      return first(result, mapUser);
    }),

  appendAudit: (input) =>
    withTenant(input.tenantId, async (client) => {
      await client.query(
        `INSERT INTO audit_log (tenant_id, actor_user_id, actor_email, action, entity_type, entity_id, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
        [
          input.tenantId,
          input.actorUserId,
          input.actorEmail,
          input.action,
          input.entityType,
          input.entityId,
          JSON.stringify(input.metadata),
        ]
      );
    }),

  listAudit: (tenantId, limit = 100) =>
    withTenant(tenantId, async (client) => {
      const result = await client.query(
        'SELECT * FROM audit_log WHERE tenant_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2',
        [tenantId, limit]
      );
      return result.rows.map(mapAudit);
    }),

  listTenants: () =>
    withSystem(async (client) => {
      const result = await client.query('SELECT * FROM tenants ORDER BY created_at');
      return result.rows.map(mapTenant);
    }),

  insertAccount: (input: AccountInput) =>
    withTenant(input.tenantId, async (client) => {
      const result = await client.query(
        `INSERT INTO channel_accounts
           (tenant_id, network, external_account_id, display_name, encrypted_secret, scopes, status, token_expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [
          input.tenantId,
          input.network,
          input.externalAccountId,
          input.displayName,
          input.encryptedSecret,
          input.scopes,
          input.status,
          input.tokenExpiresAt,
        ]
      );
      return mapAccount(result.rows[0]);
    }),

  updateAccountProviderSpec: (tenantId, id, spec) =>
    withTenant(tenantId, async (client) => {
      const result = await client.query(
        `UPDATE channel_accounts
            SET provider_max_length = $3,
                provider_rules = $4,
                specs_synced_at = now()
          WHERE tenant_id = $1 AND id = $2
          RETURNING *`,
        [tenantId, id, spec.maxLength, spec.rules]
      );
      return first(result, mapAccount);
    }),

  listAccounts: (tenantId) =>
    withTenant(tenantId, async (client) => {
      const result = await client.query(
        'SELECT * FROM channel_accounts WHERE tenant_id = $1 ORDER BY created_at',
        [tenantId]
      );
      return result.rows.map(mapAccount);
    }),

  getAccount: (tenantId, id) =>
    withTenant(tenantId, async (client) => {
      const result = await client.query(
        'SELECT * FROM channel_accounts WHERE tenant_id = $1 AND id = $2',
        [tenantId, id]
      );
      return first(result, mapAccount);
    }),

  updateAccount: (tenantId, id, changes) =>
    withTenant(tenantId, async (client) => {
      // COALESCE deixa cada campo opcional semmontar SQL dinamico: o que nao veio
      // em `changes` continua como estava.
      const result = await client.query(
        `UPDATE channel_accounts
            SET display_name = COALESCE($3, display_name),
                external_account_id = COALESCE($4, external_account_id),
                encrypted_secret = COALESCE($5, encrypted_secret),
                status = CASE WHEN $5::text IS NULL THEN status ELSE 'pending' END,
                specs_synced_at = NULL
          WHERE tenant_id = $1 AND id = $2
          RETURNING *`,
        [tenantId, id, changes.displayName ?? null, changes.externalAccountId ?? null, changes.encryptedSecret ?? null]
      );
      return first(result, mapAccount);
    }),

  deleteAccount: (tenantId, id) =>
    withTenant(tenantId, async (client) => {
      const result = await client.query('DELETE FROM channel_accounts WHERE tenant_id = $1 AND id = $2', [
        tenantId,
        id,
      ]);
      return (result.rowCount ?? 0) > 0;
    }),

  updateAccountStatus: (tenantId, id, status) =>
    withTenant(tenantId, async (client) => {
      const result = await client.query(
        'UPDATE channel_accounts SET status = $3 WHERE tenant_id = $1 AND id = $2 RETURNING *',
        [tenantId, id, status]
      );
      return first(result, mapAccount);
    }),

  insertCampaign: (input: CampaignInput) =>
    withTenant(input.tenantId, async (client: PoolClient) => {
      const result = await client.query(
        'INSERT INTO campaigns (tenant_id, name, status) VALUES ($1, $2, $3) RETURNING *',
        [input.tenantId, input.name, input.status]
      );
      return mapCampaign(result.rows[0]);
    }),

  listCampaigns: (tenantId) =>
    withTenant(tenantId, async (client) => {
      const result = await client.query(
        'SELECT * FROM campaigns WHERE tenant_id = $1 ORDER BY created_at',
        [tenantId]
      );
      return result.rows.map(mapCampaign);
    }),

  getCampaign: (tenantId, id) =>
    withTenant(tenantId, async (client) => {
      const result = await client.query(
        'SELECT * FROM campaigns WHERE tenant_id = $1 AND id = $2',
        [tenantId, id]
      );
      return first(result, mapCampaign);
    }),

  insertPost: (input: PostInput) =>
    withTenant(input.tenantId, async (client) => {
      const result = await client.query(
        `INSERT INTO posts (tenant_id, campaign_id, content_type, text, media, settings)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)
         RETURNING *`,
        [
          input.tenantId,
          input.campaignId,
          input.contentType,
          input.text,
          JSON.stringify(input.media),
          JSON.stringify(input.settings),
        ]
      );
      return mapPost(result.rows[0]);
    }),

  getPost: (tenantId, id) =>
    withTenant(tenantId, async (client) => {
      const result = await client.query('SELECT * FROM posts WHERE tenant_id = $1 AND id = $2', [
        tenantId,
        id,
      ]);
      return first(result, mapPost);
    }),

  insertJob: (input: JobInput) =>
    withTenant(input.tenantId, async (client) => {
      const result = await client.query(
        `INSERT INTO publish_jobs
           (tenant_id, post_id, channel_account_id, network, recipient, status, scheduled_at,
            attempts, external_post_id, permalink, last_error, release_id_missing)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, false)
         RETURNING *`,
        [
          input.tenantId,
          input.postId,
          input.channelAccountId,
          input.network,
          input.recipient,
          input.status,
          input.scheduledAt,
          input.attempts,
          input.externalPostId,
          input.permalink,
          input.lastError,
        ]
      );
      return mapJob(result.rows[0]);
    }),

  getJob: (tenantId, id) =>
    withTenant(tenantId, async (client) => {
      const result = await client.query(
        'SELECT * FROM publish_jobs WHERE tenant_id = $1 AND id = $2',
        [tenantId, id]
      );
      return first(result, mapJob);
    }),

  patchJob: (tenantId, id, patch) =>
    withTenant(tenantId, async (client) => {
      const assignments: string[] = [];
      const values: unknown[] = [tenantId, id];
      let position = 3;

      const push = (column: string, value: unknown): void => {
        assignments.push(`${column} = $${position}`);
        values.push(value);
        position += 1;
      };

      if (patch.status !== undefined) push('status', patch.status);
      if (patch.attempts !== undefined) push('attempts', patch.attempts);
      if (patch.externalPostId !== undefined) push('external_post_id', patch.externalPostId);
      if (patch.permalink !== undefined) push('permalink', patch.permalink);
      if (patch.lastError !== undefined) push('last_error', patch.lastError);
      if (patch.scheduledAt !== undefined) push('scheduled_at', patch.scheduledAt);
      if (patch.recipient !== undefined) push('recipient', patch.recipient);
      if (patch.releaseIdMissing !== undefined) push('release_id_missing', patch.releaseIdMissing);
      // Sempre sobrescrito pelo worker no patch de sucesso. Um job republicado
      // depois de um requeue e uma publicacao nova, e e ela que a metrica deve
      // medir. O que nao pode reescrever este campo e a reconciliacao, e ela
      // simplesmente nao envia `publishedAt`.
      if (patch.publishedAt !== undefined) push('published_at', patch.publishedAt);

      if (assignments.length === 0) {
        const current = await client.query(
          'SELECT * FROM publish_jobs WHERE tenant_id = $1 AND id = $2',
          [tenantId, id]
        );
        return first(current, mapJob);
      }

      push('updated_at', new Date().toISOString());

      const result = await client.query(
        `UPDATE publish_jobs SET ${assignments.join(', ')}
         WHERE tenant_id = $1 AND id = $2
         RETURNING *`,
        values
      );
      return first(result, mapJob);
    }),

  listJobs: (tenantId, filter = {}) =>
    withTenant(tenantId, async (client) => {
      const conditions = ['tenant_id = $1'];
      const values: unknown[] = [tenantId];
      let position = 2;

      if (filter.status) {
        conditions.push(`status = $${position}`);
        values.push(filter.status);
        position += 1;
      }

      if (filter.campaignId) {
        conditions.push(`post_id IN (SELECT id FROM posts WHERE campaign_id = $${position})`);
        values.push(filter.campaignId);
        position += 1;
      }

      const result = await client.query(
        `SELECT * FROM publish_jobs WHERE ${conditions.join(' AND ')} ORDER BY created_at`,
        values
      );
      return result.rows.map(mapJob);
    }),

  upsertDeadLetter: (input) =>
    withTenant(input.tenantId, async (client) => {
      // O ON CONFLICT reabre a entrada existente em vez de criar uma segunda.
      // Sem isso, um job que vai e volta da fila morta apareceria N vezes para o
      // operador, e "quantas vezes isso falhou" deixaria de ser legivel.
      const result = await client.query(
        `INSERT INTO dead_letter_jobs
           (tenant_id, job_id, post_id, channel_account_id, network, recipient,
            attempts, last_error, last_error_code)
         SELECT $1, j.id, j.post_id, j.channel_account_id, j.network, j.recipient,
                $3, $4::text, $5::text
           FROM publish_jobs j
          WHERE j.id = $2 AND j.tenant_id = $1
         ON CONFLICT (job_id) DO UPDATE
            SET attempts = EXCLUDED.attempts,
                last_error = EXCLUDED.last_error,
                last_error_code = EXCLUDED.last_error_code,
                resolution = NULL,
                resolved_at = NULL,
                updated_at = now()
         RETURNING *`,
        [input.tenantId, input.jobId, input.attempts, input.lastError, input.lastErrorCode]
      );
      return first(result, mapDeadLetter);
    }),

  listDeadLetters: (tenantId, filter = {}) =>
    withTenant(tenantId, async (client) => {
      const conditions = ['tenant_id = $1'];
      const values: unknown[] = [tenantId];
      let position = 2;

      if (filter.resolution === 'open') {
        conditions.push('resolution IS NULL');
      } else if (filter.resolution) {
        conditions.push(`resolution = $${position}`);
        values.push(filter.resolution);
        position += 1;
      }

      // Mais recentes primeiro: a fila morta e uma fila de triagem, e o que
      // acabou de falhar e o que o operador precisa ver primeiro.
      values.push(Math.min(Math.max(filter.limit ?? 100, 1), 500));

      const result = await client.query(
        `SELECT * FROM dead_letter_jobs
          WHERE ${conditions.join(' AND ')}
          ORDER BY created_at DESC
          LIMIT $${position}`,
        values
      );
      return result.rows.map(mapDeadLetter);
    }),

  getDeadLetter: (tenantId, id) =>
    withTenant(tenantId, async (client) => {
      const result = await client.query(
        'SELECT * FROM dead_letter_jobs WHERE tenant_id = $1 AND id = $2',
        [tenantId, id]
      );
      return first(result, mapDeadLetter);
    }),

  resolveDeadLetter: (tenantId, id, resolution) =>
    withTenant(tenantId, async (client) => {
      // Reabrir uma entrada ja descartada exigiria DELETE, e a tabela nao tem
      // essa permissao de proposito: fila morta e registro, nao rascunho.
      const result = await client.query(
        `UPDATE dead_letter_jobs
            SET resolution = $3,
                resolved_at = now(),
                requeue_count = requeue_count + CASE WHEN $3 = 'requeued' THEN 1 ELSE 0 END,
                updated_at = now()
          WHERE tenant_id = $1 AND id = $2
          RETURNING *`,
        [tenantId, id, resolution]
      );
      return first(result, mapDeadLetter);
    }),

  insertTemplate: (input: TemplateInput) =>
    withTenant(input.tenantId, async (client) => {
      const result = await client.query(
        `INSERT INTO whatsapp_templates
           (tenant_id, name, language_code, category, status, header_type, variable_count)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [
          input.tenantId,
          input.name,
          input.languageCode,
          input.category,
          input.status,
          input.headerType,
          input.variableCount,
        ]
      );
      return mapTemplate(result.rows[0]);
    }),

  listTemplates: (tenantId) =>
    withTenant(tenantId, async (client) => {
      const result = await client.query(
        'SELECT * FROM whatsapp_templates WHERE tenant_id = $1 ORDER BY created_at',
        [tenantId]
      );
      return result.rows.map(mapTemplate);
    }),

  findTemplate: (tenantId, name, languageCode) =>
    withTenant(tenantId, async (client) => {
      const result = await client.query(
        'SELECT * FROM whatsapp_templates WHERE tenant_id = $1 AND name = $2 AND language_code = $3 LIMIT 1',
        [tenantId, name, languageCode]
      );
      return first(result, mapTemplate);
    }),

  updateTemplateStatus: (tenantId, id, status) =>
    withTenant(tenantId, async (client) => {
      const result = await client.query(
        'UPDATE whatsapp_templates SET status = $3 WHERE tenant_id = $1 AND id = $2 RETURNING *',
        [tenantId, id, status]
      );
      return first(result, mapTemplate);
    }),

  close: closePool,
});
