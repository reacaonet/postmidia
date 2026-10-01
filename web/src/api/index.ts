import { api, type ApiError } from './client';
import type {
  AccountSettings,
  AuditEntry,
  Campaign,
  ChannelAccount,
  CapabilityEntry,
  CreatePostResult,
  DeadLetterJob,
  JobStatus,
  NetworksResponse,
  OpsMetrics,
  PublishJob,
  ReconcileResult,
  TenantRef,
  WhatsappTemplate,
} from './types';

const q = (params: Record<string, string | number | undefined>): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') {
      search.set(key, String(value));
    }
  }
  const text = search.toString();
  return text.length > 0 ? `?${text}` : '';
};

/**
 * `GET /health` nao usa o envelope `{success,data}` — e o unico retorno cru da
 * API. Por isso fica fora de `api.get<T>`, que assume envelope.
 */
export async function health(): Promise<{ status: string; service: string }> {
  const response = await fetch('/api/health');
  return (await response.json()) as { status: string; service: string };
}

/** Sem token. `GET /networks` e `GET /capabilities` sao publicas. */
export const getNetworks = (): Promise<{ data: NetworksResponse }> => api.get('/networks');
export const getCapabilities = (): Promise<{ data: CapabilityEntry[] }> => api.get('/capabilities');

// ------------------------------------------------------------------ auth

export const signup = (body: {
  tenantName: string;
  slug: string;
  email: string;
  password: string;
}): Promise<{ data: { token: string; user: unknown; tenant: unknown } }> =>
  api.post('/auth/signup', body);

/**
 * Sem `slug`: o login e por e-mail e senha. A API confere a senha contra todos os
 * tenants que tenham esse e-mail e concede o unico que casar; se a mesma senha
 * existir em duas empresas, responde 409 pedindo o slug.
 *
 * `tenant` volta no login porque o painel precisa do nome da empresa e, sem o
 * slug no pedido, nao teria como saber.
 */
export const login = (body: {
  email: string;
  password: string;
  slug?: string;
}): Promise<{ data: { token: string; user: unknown; tenant: TenantRef | null } }> =>
  api.post('/auth/login', body);

export const me = (
  token: string
): Promise<{ data: { user: unknown; tenantId: string; role: string } }> =>
  api.get('/auth/me', token);

/**
 * `GET /audit` fica na RAIZ, nao sob `/auth`. O router de auth foi montado sem
 * prefixo, entao o caminho real e `/audit`.
 */
export const getAudit = (token: string, limit = 100): Promise<{ data: AuditEntry[] }> =>
  api.get(`/audit${q({ limit })}`, token);

// -------------------------------------------------------------- accounts

export const getAccounts = (token: string): Promise<{ data: ChannelAccount[] }> =>
  api.get('/accounts', token);

export const createAccount = (
  token: string,
  body: {
    network: string;
    externalAccountId: string;
    displayName: string;
    secret: string;
    scopes?: string[];
  }
): Promise<{ data: ChannelAccount }> => api.post('/accounts', body, token);

export const syncAccountSpecs = (
  token: string,
  id: string
): Promise<{ data: ChannelAccount }> => api.post(`/accounts/${id}/sync-specs`, undefined, token);

export const setAccountStatus = (
  token: string,
  id: string,
  status: string
): Promise<{ data: ChannelAccount }> =>
  api.patch(`/accounts/${id}/status`, { status }, token);

export const getAccountSettings = (
  token: string,
  id: string
): Promise<{ data: AccountSettings }> => api.get(`/accounts/${id}/settings`, token);

// ------------------------------------------------------------ campaigns

export const getCampaigns = (token: string): Promise<{ data: Campaign[] }> =>
  api.get('/campaigns', token);

export const createCampaign = (token: string, name: string): Promise<{ data: Campaign }> =>
  api.post('/campaigns', { name }, token);

export const createPost = (
  token: string,
  campaignId: string,
  body: {
    contentType: string;
    text?: string;
    media?: Array<{ kind: 'image' | 'video'; url: string; bytes?: number; durationSeconds?: number }>;
    settings?: Record<string, unknown>;
    accountIds: string[];
    audience?: string[];
    /** Precisa do sufixo `Z`: o zod `.datetime()` rejeita `-03:00`. */
    scheduledAt?: string;
  }
): Promise<{ data: CreatePostResult }> => api.post(`/campaigns/${campaignId}/posts`, body, token);

/** `GET /jobs` tambem esta na raiz, nao sob `/campaigns`. */
export const getJobs = (
  token: string,
  params: { status?: JobStatus; campaignId?: string } = {}
): Promise<{ data: PublishJob[] }> => api.get(`/jobs${q(params)}`, token);

/**
 * Reconciliar devolve 202 com `success:true` quando o Postiz ainda nao tem o
 * id. Isso e resultado legitimo, entao o `fetch` normal (que so lanca em !ok)
 * funciona; o painel trata pelo `outcome`.
 */
export const reconcileJob = (
  token: string,
  id: string
): Promise<{ data: ReconcileResult }> => api.post(`/jobs/${id}/reconcile`, undefined, token);

// ------------------------------------------------------------ templates

export const getTemplates = (token: string): Promise<{ data: WhatsappTemplate[] }> =>
  api.get('/whatsapp/templates', token);

export const createTemplate = (
  token: string,
  body: {
    name: string;
    languageCode?: string;
    category?: string;
    status?: string;
    headerType?: string;
    variableCount?: number;
  }
): Promise<{ data: WhatsappTemplate }> => api.post('/whatsapp/templates', body, token);

export const setTemplateStatus = (
  token: string,
  id: string,
  status: string
): Promise<{ data: WhatsappTemplate }> =>
  api.patch(`/whatsapp/templates/${id}/status`, { status }, token);

// --------------------------------------------------------- dead letters

export const getDeadLetters = (
  token: string,
  params: { resolution?: 'open' | 'requeued' | 'discarded'; limit?: number } = {}
): Promise<{ data: DeadLetterJob[] }> => api.get(`/dead-letters${q(params)}`, token);

/**
 * `requeue` devolve `{deadLetter, job}` e `discard` devolve a entrada direto.
 * A uniao e treatmenta no chamador.
 */
export const resolveDeadLetter = (
  token: string,
  id: string,
  action: 'requeue' | 'discard'
): Promise<{ data: unknown }> => api.post(`/dead-letters/${id}/resolve`, { action }, token);

// ------------------------------------------------------------------ ops

/**
 * O painel operacional NAO aceita o JWT de tenant: usa `x-metrics-token`, que
 * e segredo de plataforma. A rota conta jobs de todos os clientes e `owner` e
 * papel por tenant, entao proteger com ele mostraria a fila inteira para o dono
 * de qualquer loja.
 */
export async function getMetrics(params: {
  token: string;
  windowHours?: number;
  tenantId?: string;
}): Promise<{ data: OpsMetrics }> {
  const response = await fetch(`/api/ops/metrics${q({ windowHours: params.windowHours, tenantId: params.tenantId })}`, {
    headers: { 'x-metrics-token': params.token },
  });
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  if (!response.ok) {
    const body = parsed as { error?: string } | null;
    const error = new Error(body?.error ?? `Erro ${response.status}`) as Error & {
      status?: number;
    };
    error.status = response.status;
    throw error;
  }
  return parsed as { data: OpsMetrics };
}

export type { ApiError };
