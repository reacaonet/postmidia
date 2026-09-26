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
import type { Store } from './types';

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
      const created: PublishJob = { ...input, id: newId(), createdAt: timestamp, updatedAt: timestamp };
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
