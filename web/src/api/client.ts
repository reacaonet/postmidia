/**
 * Cliente HTTP.
 *
 * **O envelope de erro nao e uniforme, e essa e a razao de `ApiError` carregar o
 * corpo inteiro.** O handler global da API emite `{success:false, error:string}`,
 * mas seis rotas acrescentam `data` com formatos diferentes: `flatten()` do zod
 * no 400, `detail` no 502 do sync-specs, um array de rejeicoes no 422 de post,
 * `DeadLetterJob` no 409 de resolve. O painel precisa mostrar a mensagem de cada
 * um, entao o corpo fica disponivel e o `describeError` sabe extrair o que
 * houver.
 *
 * Nao existe `code` no envelope de erro da API: `error` e sempre mensagem em
 * portugues. Status HTTP e a unica autoridade.
 */

export interface ApiErrorBody {
  success: false;
  error: string;
  detail?: string;
  data?: unknown;
}

export class ApiError extends Error {
  readonly status: number;
  readonly body: ApiErrorBody | null;
  /** Resposta sem envelope — `/health` e o unico caso na API. */
  readonly raw: string | null;

  constructor(status: number, body: ApiErrorBody | null, raw: string | null) {
    super(body?.error ?? `Erro ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
    this.raw = raw;
  }

  /** 401 e o caso que exige reautenticar, e o painel trata diferente. */
  get isUnauthorized(): boolean {
    return this.status === 401;
  }

  /** 403 tem duas causas distintas que o painel precisa separar. */
  get isForbidden(): boolean {
    return this.status === 403;
  }

  get isConflict(): boolean {
    return this.status === 409;
  }

  /**
   * Rotas de escrita exigem owner|admin. O 403 do `requireRole` traz a frase
   * "nao pode executar esta operacao"; o 403 de signup desligado e do outro
   * lado. Separar os dois evita mostrar "faca login como admin" para quem so
   * precisa que o signup seja habilitado.
   */
  get isRoleError(): boolean {
    return this.status === 403 && this.message.includes('Papel');
  }
}

const BASE = '/api';

async function request<T>(
  path: string,
  options: { method?: string; body?: unknown; token?: string | null } = {}
): Promise<T> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  if (options.token) {
    headers.Authorization = `Bearer ${options.token}`;
  }

  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch (cause) {
    // `fetch` so rejeita em falha de rede/DNS. Um 500 do backend chega como
    // resposta normal e cai no caminho de baixo. Traduzir aqui evita que o
    // painel mostre "Failed to fetch", que nao diz se o backend caiu ou se o
    // Vite subiu.
    throw new ApiError(0, null, `Falha de rede ao chamar ${path}: ${String(cause)}`);
  }

  const text = await response.text();
  let parsed: unknown = null;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }

  if (!response.ok) {
    const isEnvelope =
      parsed !== null &&
      typeof parsed === 'object' &&
      'success' in (parsed as Record<string, unknown>);
    throw new ApiError(
      response.status,
      isEnvelope ? (parsed as ApiErrorBody) : null,
      isEnvelope ? null : text || null
    );
  }

  // 204 e 205 nao tem corpo; devolver undefined e melhor que parsear "" e falhar.
  if (text.length === 0) {
    return undefined as T;
  }
  return parsed as T;
}

export const api = {
  get: <T>(path: string, token?: string | null): Promise<T> => request<T>(path, { token }),
  post: <T>(path: string, body?: unknown, token?: string | null): Promise<T> =>
    request<T>(path, { method: 'POST', body, token }),
  patch: <T>(path: string, body?: unknown, token?: string | null): Promise<T> =>
    request<T>(path, { method: 'PATCH', body, token }),
};

/**
 * Extrai a mensagem que o operador precisa ver.
 *
 * As mensagens do zod vem em ingles (`String must contain at least 2
 * character(s)`) enquanto todo o resto da API fala portugues. Mostrar as duas
 * cruas no painel e confuso, entao o `fieldErrors` ganha rotulo legivel a
 * partir do nome do campo.
 */
const FIELD_LABELS: Record<string, string> = {
  tenantName: 'Nome da empresa',
  slug: 'Identificador (slug)',
  email: 'E-mail',
  password: 'Senha',
  network: 'Rede',
  externalAccountId: 'Id da conta na rede',
  displayName: 'Nome de exibicao',
  secret: 'Token',
  scopes: 'Permissoes',
  tokenExpiresAt: 'Validade do token',
  status: 'Status',
  name: 'Nome',
  contentType: 'Tipo de conteudo',
  text: 'Texto',
  media: 'Midia',
  settings: 'Configuracao',
  accountIds: 'Contas',
  audience: 'Publico',
  scheduledAt: 'Data agendada',
  languageCode: 'Idioma',
  category: 'Categoria',
  headerType: 'Cabecalho',
  variableCount: 'Variaveis',
  action: 'Acao',
  limit: 'Limite',
  resolution: 'Situacao',
};

const label = (field: string): string => FIELD_LABELS[field] ?? field;

export function describeError(error: unknown): string {
  if (!(error instanceof ApiError)) {
    return error instanceof Error ? error.message : String(error);
  }

  if (error.status === 0) {
    return error.raw ?? 'Falha de rede';
  }

  const data = error.body?.data;

  // 400 de zod: { formErrors: string[], fieldErrors: { campo: string[] } }
  if (
    data !== null &&
    typeof data === 'object' &&
    'fieldErrors' in (data as Record<string, unknown>)
  ) {
    const { formErrors, fieldErrors } = data as {
      formErrors?: string[];
      fieldErrors?: Record<string, string[]>;
    };
    const parts: string[] = [];
    for (const [field, messages] of Object.entries(fieldErrors ?? {})) {
      for (const message of messages ?? []) {
        // A mensagem do zod em ingles nao ajuda o operador; o rotulo do campo ajuda.
        parts.push(`${label(field)}: ${message}`);
      }
    }
    for (const message of formErrors ?? []) {
      parts.push(message);
    }
    if (parts.length > 0) {
      return `${error.message} — ${parts.join('; ')}`;
    }
  }

  // 422 de validacao de post: data e um array de grupos por conta.
  if (Array.isArray(data) && data.length > 0) {
    const first = data[0] as { issues?: Array<{ message?: string }> } | undefined;
    const issues = first?.issues ?? [];
    if (issues.length > 0) {
      const detail = issues.map((issue) => issue.message ?? '').filter(Boolean).join('; ');
      const extra = data.length > 1 ? ` (+${data.length - 1} conta${data.length > 2 ? 's' : ''})` : '';
      return `${error.message} — ${detail}${extra}`;
    }
  }

  // 502 do sync-specs traz `detail` alem do `error`.
  if (error.body?.detail) {
    return `${error.message} — ${error.body.detail}`;
  }

  return error.message;
}

/**
 * Lista os grupos de rejeicao do 422 para a tela de agendamento.
 *
 * O `data` do 422 e um array, e o mesmo nome `data` no sucesso e objeto. Nao da
 * para assumir `data` uniforme, entao a checagem de array acontece aqui e o
 * chamador recebe algo tipado.
 */
export function rejectionGroups(error: unknown): Array<{
  accountId: string;
  network: string;
  issues: Array<{ field: string; code: string; message: string }>;
}> {
  if (!(error instanceof ApiError) || !Array.isArray(error.body?.data)) {
    return [];
  }
  return error.body.data as Array<{
    accountId: string;
    network: string;
    issues: Array<{ field: string; code: string; message: string }>;
  }>;
}
