import { env } from '../config';
import { createMemoryStore, toPublicAccount, toPublicUser } from './memory.store';
import { createPostgresStore } from './postgres.store';
import type { Store } from './types';

export const store: Store = env.DATABASE_URL ? createPostgresStore() : createMemoryStore();

if (env.DATABASE_URL) {
  console.log('[store] backend: postgres');
} else {
  console.log('[store] backend: memory (defina DATABASE_URL para persistir)');
}

export const {
  createTenant,
  getTenant,
  getTenantBySlug,
  listTenants,
  insertUser,
  findUserByEmail,
  findUserById,
  appendAudit,
  listAudit,
  insertAccount,
  listAccounts,
  getAccount,
  updateAccountStatus,
  updateAccountProviderSpec,
  insertCampaign,
  listCampaigns,
  getCampaign,
  insertPost,
  getPost,
  insertJob,
  getJob,
  patchJob,
  listJobs,
  listJobsPendingReconciliation,
  getOpsMetrics,
  getTenantOpsMetrics,
  upsertDeadLetter,
  listDeadLetters,
  getDeadLetter,
  resolveDeadLetter,
  insertTemplate,
  listTemplates,
  findTemplate,
  updateTemplateStatus,
} = store;

export { toPublicAccount, toPublicUser };
export type { Store, ProviderSpec, DeadLetterFilter } from './types';
