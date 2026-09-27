import { randomUUID } from 'node:crypto';
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
import type { OpsMetrics, Store } from './types';

/**
 * Percentil continuo, com interpolacao linear -- o mesmo calculo do
 * `percentile_cont` do Postgres.
 *
 * A paridade importa: o fallback em memoria e o Postgres sao as duas
 * implementacoes da mesma metrica, e um p95 divergente entre elas faria o numero
 * mudar conforme o backend, sem ninguem entender o por que.
 */
const percentileCont = (sorted: number[], fraction: number): number | null => {
  if (sorted.length === 0) {
    return null;
  }
  if (sorted.length === 1) {
    return sorted[0];
  }
  const rank = fraction * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) {
    return sorted[lower];
  }
  return sorted[lower] + (rank - lower) * (sorted[upper] - sorted[lower]);
};

/**
 * Monta as metricas a partir de colecoes em memoria, com a mesma semantica da
 * versao SQL: volume por rede e latencia respeitam a janela; pendencias nao.
 */
const metricsFrom = (
  allJobs: PublishJob[],
  allDeadLetters: DeadLetterJob[],
  windowHours: number,
  tenantId: string | null,
  tenantName: string | null
): OpsMetrics => {
  const hours = Math.max(1, Math.min(Math.floor(windowHours) || 24, 24 * 30));
  const cutoff = Date.now() - hours * 3_600_000;
  const inWindow = (stamp: string): boolean => new Date(stamp).getTime() > cutoff;

  const byStatus: Record<string, number> = {};
  for (const job of allJobs) {
    byStatus[job.status] = (byStatus[job.status] ?? 0) + 1;
  }

  const windowJobs = allJobs.filter((job) => inWindow(job.createdAt));

  const perNetwork = new Map<string, { total: number; succeeded: number; failed: number }>();
  for (const job of windowJobs) {
    const bucket = perNetwork.get(job.network) ?? { total: 0, succeeded: 0, failed: 0 };
    bucket.total += 1;
    if (job.status === 'succeeded') {
      bucket.succeeded += 1;
    }
    if (job.status === 'failed') {
      bucket.failed += 1;
    }
    perNetwork.set(job.network, bucket);
  }

  const samples = windowJobs
    .filter((job) => job.status === 'succeeded' && job.publishedAt)
    .map((job) => (new Date(job.publishedAt!).getTime() - new Date(job.scheduledAt).getTime()) / 1000)
    .sort((a, b) => a - b);

  return {
    windowHours: hours,
    generatedAt: new Date().toISOString(),
    byStatus,
    byNetwork: [...perNetwork.entries()]
      .map(([network, bucket]) => ({
        network,
        total: bucket.total,
        succeeded: bucket.succeeded,
        failed: bucket.failed,
        failureRate:
          bucket.total > 0 ? Math.round((bucket.failed / bucket.total) * 10_000) / 10_000 : null,
      }))
      .sort((a, b) => b.total - a.total || a.network.localeCompare(b.network)),
    latency: {
      samples: samples.length,
      p50Seconds: percentileCont(samples, 0.5),
      p95Seconds: percentileCont(samples, 0.95),
      maxSeconds: samples.length > 0 ? samples[samples.length - 1] : null,
    },
    pendingReconciliation: allJobs.filter((job) => job.releaseIdMissing).length,
    openDeadLetters: allDeadLetters.filter((entry) => entry.resolution === null).length,
    tenantId,
    tenantName,
  };
};

const newId = (): string => randomUUID();

export const toPublicAccount = <T extends ChannelAccount>(account: T): Omit<T, 'encryptedSecret'> => {
  const { encryptedSecret: _omitted, ...rest } = account;
  return rest;
};

export const toPublicUser = (user: User): Omit<User, 'passwordHash'> => {
  const { passwordHash: _omitted, ...rest } = user;
  return rest;
};

export const createMemoryStore = (): Store => {
  const tenants = new Map<string, Tenant>();
  const users = new Map<string, User>();
  const audit: AuditEntry[] = [];
  const accounts = new Map<string, ChannelAccount>();
  const campaigns = new Map<string, Campaign>();
  const posts = new Map<string, Post>();
  const jobs = new Map<string, PublishJob>();
  const deadLetters = new Map<string, DeadLetterJob>();
  const templates = new Map<string, WhatsappTemplate>();

  const now = (): string => new Date().toISOString();

  return {
    async createTenant(input) {
      const tenant: Tenant = { id: newId(), name: input.name, slug: input.slug, createdAt: now() };
      tenants.set(tenant.id, tenant);
      return tenant;
    },

    async getTenant(id) {
      return tenants.get(id);
    },

    async getTenantBySlug(slug) {
      return [...tenants.values()].find((tenant) => tenant.slug === slug);
    },

    async insertUser(input) {
      const created: User = {
        id: newId(),
        tenantId: input.tenantId,
        email: input.email.toLowerCase(),
        passwordHash: input.passwordHash,
        role: input.role as User['role'],
        status: 'active',
        createdAt: now(),
      };
      users.set(created.id, created);
      return created;
    },

    async findUserByEmail(tenantId, email) {
      const normalized = email.toLowerCase();
      return [...users.values()].find(
        (user) => user.tenantId === tenantId && user.email === normalized
      );
    },

    async findUserById(tenantId, id) {
      const user = users.get(id);
      return user && user.tenantId === tenantId ? user : undefined;
    },

    async appendAudit(input) {
      audit.push({
        ...input,
        actorUserId: input.actorUserId ?? null,
        actorEmail: input.actorEmail ?? null,
        entityId: input.entityId ?? null,
        metadata: input.metadata ?? {},
        id: String(audit.length + 1),
        createdAt: now(),
      });
    },

    async listAudit(tenantId, limit = 100) {
      return audit.filter((entry) => entry.tenantId === tenantId).slice(-limit).reverse();
    },

    async listTenants() {
      return [...tenants.values()];
    },

    async insertAccount(input) {
      const created: ChannelAccount = {
        ...input,
        providerMaxLength: null,
        providerRules: null,
        specsSyncedAt: null,
        id: newId(),
        createdAt: now(),
      };
      accounts.set(created.id, created);
      return created;
    },

    async listAccounts(tenantId) {
      return [...accounts.values()].filter((account) => account.tenantId === tenantId);
    },

    async getAccount(tenantId, id) {
      const account = accounts.get(id);
      return account && account.tenantId === tenantId ? account : undefined;
    },

    async updateAccountStatus(tenantId, id, status) {
      const account = accounts.get(id);
      if (!account || account.tenantId !== tenantId) {
        return undefined;
      }
      const updated = { ...account, status };
      accounts.set(id, updated);
      return updated;
    },

    async updateAccountProviderSpec(tenantId, id, spec) {
      const account = accounts.get(id);
      if (!account || account.tenantId !== tenantId) {
        return undefined;
      }
      const updated = {
        ...account,
        providerMaxLength: spec.maxLength,
        providerRules: spec.rules,
        specsSyncedAt: now(),
      };
      accounts.set(id, updated);
      return updated;
    },

    async insertCampaign(input) {
      const created: Campaign = { ...input, id: newId(), createdAt: now() };
      campaigns.set(created.id, created);
      return created;
    },

    async listCampaigns(tenantId) {
      return [...campaigns.values()].filter((campaign) => campaign.tenantId === tenantId);
    },

    async getCampaign(tenantId, id) {
      const campaign = campaigns.get(id);
      return campaign && campaign.tenantId === tenantId ? campaign : undefined;
    },

    async insertPost(input) {
      const created: Post = { ...input, id: newId(), createdAt: now() };
      posts.set(created.id, created);
      return created;
    },

    async getPost(tenantId, id) {
      const post = posts.get(id);
      return post && post.tenantId === tenantId ? post : undefined;
    },

    async insertJob(input) {
      const timestamp = now();
      const created: PublishJob = {
        ...input,
        releaseIdMissing: false,
        publishedAt: null,
        id: newId(),
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      jobs.set(created.id, created);
      return created;
    },

    async getJob(tenantId, id) {
      const job = jobs.get(id);
      return job && job.tenantId === tenantId ? job : undefined;
    },

    async patchJob(tenantId, id, patch) {
      const current = jobs.get(id);
      if (!current || current.tenantId !== tenantId) {
        return undefined;
      }
      const updated: PublishJob = { ...current, ...patch, updatedAt: now() };
      jobs.set(id, updated);
      return updated;
    },

    async listJobs(tenantId, filter = {}) {
      const postIdsByCampaign = filter.campaignId
        ? new Set(
            [...posts.values()]
              .filter((post) => post.campaignId === filter.campaignId)
              .map((post) => post.id)
          )
        : undefined;

      return [...jobs.values()].filter((job) => {
        if (job.tenantId !== tenantId) {
          return false;
        }
        if (filter.status && job.status !== filter.status) {
          return false;
        }
        if (postIdsByCampaign && !postIdsByCampaign.has(job.postId)) {
          return false;
        }
        return true;
      });
    },

    async listJobsPendingReconciliation(limit) {
      return [...jobs.values()]
        .filter((job) => job.releaseIdMissing)
        .sort((a, b) => (a.updatedAt < b.updatedAt ? -1 : 1))
        .slice(0, limit);
    },

    async upsertDeadLetter(input) {
      const job = jobs.get(input.jobId);
      if (!job || job.tenantId !== input.tenantId) {
        return undefined;
      }
      const existing = [...deadLetters.values()].find(
        (entry) => entry.jobId === input.jobId && entry.tenantId === input.tenantId
      );
      const timestamp = now();
      const entry: DeadLetterJob = {
        id: existing?.id ?? newId(),
        tenantId: input.tenantId,
        jobId: job.id,
        postId: job.postId,
        channelAccountId: job.channelAccountId,
        network: job.network,
        recipient: job.recipient,
        attempts: input.attempts,
        lastError: input.lastError,
        lastErrorCode: input.lastErrorCode,
        // Reabrir e o espelho do ON CONFLICT do Postgres: a entrada volta a
        // ficar aberta em vez de duplicar.
        resolution: null,
        resolvedAt: null,
        requeueCount: existing?.requeueCount ?? 0,
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
      };
      deadLetters.set(entry.id, entry);
      return entry;
    },

    async listDeadLetters(tenantId, filter = {}) {
      return [...deadLetters.values()]
        .filter((entry) => {
          if (entry.tenantId !== tenantId) {
            return false;
          }
          if (filter.resolution === 'open') {
            return entry.resolution === null;
          }
          if (filter.resolution) {
            return entry.resolution === filter.resolution;
          }
          return true;
        })
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
        .slice(0, Math.min(Math.max(filter.limit ?? 100, 1), 500));
    },

    async getDeadLetter(tenantId, id) {
      const entry = deadLetters.get(id);
      return entry && entry.tenantId === tenantId ? entry : undefined;
    },

    async resolveDeadLetter(tenantId, id, resolution) {
      const entry = deadLetters.get(id);
      if (!entry || entry.tenantId !== tenantId) {
        return undefined;
      }
      const updated: DeadLetterJob = {
        ...entry,
        resolution,
        resolvedAt: now(),
        requeueCount: entry.requeueCount + (resolution === 'requeued' ? 1 : 0),
        updatedAt: now(),
      };
      deadLetters.set(id, updated);
      return updated;
    },

    async insertTemplate(input) {
      const created: WhatsappTemplate = { ...input, id: newId(), createdAt: now() };
      templates.set(created.id, created);
      return created;
    },

    async listTemplates(tenantId) {
      return [...templates.values()].filter((template) => template.tenantId === tenantId);
    },

    async findTemplate(tenantId, name, languageCode) {
      return [...templates.values()].find(
        (template) =>
          template.tenantId === tenantId &&
          template.name === name &&
          template.languageCode === languageCode
      );
    },

    async updateTemplateStatus(tenantId, id, status) {
      const existing = templates.get(id);
      if (!existing || existing.tenantId !== tenantId) {
        return undefined;
      }
      const updated = { ...existing, status };
      templates.set(id, updated);
      return updated;
    },

    async getOpsMetrics(windowHours) {
      return metricsFrom([...jobs.values()], [...deadLetters.values()], windowHours, null, null);
    },

    async getTenantOpsMetrics(tenantId, windowHours) {
      const scoped = [...jobs.values()].filter((job) => job.tenantId === tenantId);
      const scopedDeadLetters = [...deadLetters.values()].filter(
        (entry) => entry.tenantId === tenantId
      );
      // Nome do tenant vem do proprio registro, e nao de um filtro por job: uma
      // DLQ cujo job sumiu nao pode virar um furo na contagem do tenant.
      return metricsFrom(
        scoped,
        scopedDeadLetters,
        windowHours,
        tenantId,
        tenants.get(tenantId)?.name ?? null
      );
    },

    async close() {
      tenants.clear();
      users.clear();
      audit.length = 0;
      accounts.clear();
      campaigns.clear();
      posts.clear();
      jobs.clear();
      templates.clear();
    },
  };
};
