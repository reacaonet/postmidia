import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const envSchema = z.object({
  PORT: z.coerce.number().default(8601),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  JWT_SECRET: z.string().min(10).default('postmidia-dev-jwt-secret'),
  JWT_TTL: z.string().default('12h'),
  ALLOW_TENANT_HEADER: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  ALLOW_SELF_SIGNUP: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000).default(60_000),
  RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().min(1).default(300),
  TOKEN_ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'TOKEN_ENCRYPTION_KEY deve ser 64 caracteres hex (32 bytes)'),
  // 4007 e a porta que o docker-compose publica; 5000 e a interna do nginx.
  POSTIZ_API_BASE_URL: z.string().url().default('http://localhost:4007/api/public/v1'),
  // Versao da Graph API usada no envio de mensagem do WhatsApp. Precisa do
  // prefixo `v`: a API rejeita `21.0` com 400 e o erro nao menciona o formato.
  // Pinada por padrao; o formato e conferido aqui para que o erro de boot aponte
  // a config, e nao a URL 400 que apareceria no primeiro envio em producao.
  WHATSAPP_GRAPH_VERSION: z
    .string()
    .regex(/^v\d+\.\d+$/, 'WHATSAPP_GRAPH_VERSION precisa ser "vN.N", ex.: v21.0')
    .default('v21.0'),
  POSTIZ_API_KEY: z.string().default(''),
  TELEGRAM_BOT_TOKEN: z.string().default(''),
  DATABASE_URL: z.string().default(''),
  DATABASE_MIGRATION_URL: z.string().default(''),
  DATABASE_APP_PASSWORD: z.string().default(''),
  REDIS_URL: z.string().default(''),
  PUBLISH_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(5),
  PUBLISH_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(5),
  PUBLISH_BACKOFF_BASE_MS: z.coerce.number().int().min(100).default(30_000),
  // Reconciliacao de releaseIdMissing. Desligada por padrao: quem liga e o
  // worker, e o operador pode nao querer varredura automatica num deploy.
  RECONCILE_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  RECONCILE_INTERVAL_MS: z.coerce.number().int().min(30_000).default(300_000),
  // Teto por passada. `getMissingContent` pode dormir 10s dentro da chamada
  // quando a integracao tem refreshWait, entao um lote grande seguraria o
  // worker por minutos.
  RECONCILE_BATCH: z.coerce.number().int().min(1).max(50).default(5),
  // Token de plataforma do painel operacional. Deliberadamente NAO e um JWT de
  // tenant: as metricas atravessam tenants e `owner`/`admin` sao papeis por
  // tenant. Vazio em dev mantem a rota fechada com 503, nunca aberta.
  METRICS_TOKEN: z.string().default(''),
  METRICS_WINDOW_HOURS: z.coerce.number().int().min(1).max(720).default(24),
  // Libera a sonda de midia para enderecos privados. Existe para os testes, que
  // servem a midia de `127.0.0.1`. Fora disso e exatamente o buraco de SSRF que a
  // sonda existe para fechar, entao o boot em producao recusa o processo.
  MEDIA_PROBE_ALLOW_PRIVATE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  // Sonda de midia ligada por padrao. Desligar restaura o comportamento antigo
  // (so valida o que o cliente declara), que e o que nao devemos querer.
  MEDIA_PROBE_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  EMBEDDED_WORKER: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
});

/**
 * O schema exportado, para o `verify:provider-specs` conferir o formato da
 * versao da Graph API sem duplicar a regra em dois lugares. So o schema: nao o
 * resultado do parse, porque o boot ja saiu com codigo 1 se algo estiver errado.
 */
export const WHATSAPP_GRAPH_VERSION_SCHEMA = envSchema.shape.WHATSAPP_GRAPH_VERSION;

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment variables:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
export type Env = z.infer<typeof envSchema>;

/** Segredos de exemplo que nunca devem chegar a producao. */
const PLACEHOLDER_SECRETS = new Set([
  'postmidia-dev-jwt-secret',
  'change-me',
  'changeme',
  'secret',
  'trocar',
  'password',
]);

/**
 * Invariantes que so importam em producao, verificadas uma vez no boot.
 *
 * Config invalida que nao trava o processo vira incidente em producao: um
 * `JWT_SECRET` de exemplo significa que qualquer um forja token de admin, e uma
 * `REDIS_URL` vazia significa que a fila para de agendar sem ninguem perceber.
 * Por isso isso sai com codigo 1 e mensagem acionavel, nao com warning.
 */
export function assertProductionSafety(): void {
  if (env.NODE_ENV !== 'production') return;

  const blocking: string[] = [];
  const warnings: string[] = [];

  if (PLACEHOLDER_SECRETS.has(env.JWT_SECRET) || env.JWT_SECRET.length < 32) {
    blocking.push(
      'JWT_SECRET e fraco ou e um valor de exemplo. Gere um segredo proprio: openssl rand -hex 32'
    );
  }

  if (/^0+$/.test(env.TOKEN_ENCRYPTION_KEY) || /^f+$/i.test(env.TOKEN_ENCRYPTION_KEY)) {
    blocking.push(
      'TOKEN_ENCRYPTION_KEY e a chave nula. Gere uma: openssl rand -hex 32. Trocar depois quebra os segredos ja cifrados.'
    );
  }

  if (env.ALLOW_TENANT_HEADER) {
    blocking.push(
      'ALLOW_TENANT_HEADER nao pode ser true em producao: o header nao e assinado e permitiria forjar o tenant.'
    );
  }

  if (env.MEDIA_PROBE_ALLOW_PRIVATE) {
    blocking.push(
      'MEDIA_PROBE_ALLOW_PRIVATE nao pode ser true em producao: a sonda de midia buscaria URLs internas ' +
        '(metadados de nuvem, Redis, Postgres em rede privada) numa URL escolhida pelo cliente.'
    );
  }

  if (!env.DATABASE_URL) {
    blocking.push('DATABASE_URL nao definido: sem banco a API sobe e falha em toda requisicao.');
  }

  if (!env.REDIS_URL) {
    blocking.push(
      'REDIS_URL nao definido: a fila nao agenda nada. A API apenas sobe com a degradacao silenciosa.'
    );
  }

  if (env.ALLOW_SELF_SIGNUP) {
    warnings.push(
      'ALLOW_SELF_SIGNUP=true cria tenants publicamente. Se o produto usa convite, desligue.'
    );
  }

  if (!env.POSTIZ_API_KEY) {
    warnings.push('POSTIZ_API_KEY vazio: os canais via Postiz vao falhar na publicacao.');
  }

  // O painel operacional e leitura que ATRAVESSA tenants, entao nao pode usar o
  // JWT de tenant: `owner` e um papel por tenant, e qualquer owner leria a
  // contagem de jobs de todos os outros. Da o token proprio de plataforma, e
  // producao exige que ele exista em vez de confiar em "ninguem vai olhar".
  if (!env.METRICS_TOKEN || env.METRICS_TOKEN.length < 32) {
    blocking.push(
      'METRICS_TOKEN ausente ou curto (minimo 32 caracteres): o painel operacional atravessa tenants ' +
        'e nao pode ficar protegido so por JWT de tenant. Gere com openssl rand -hex 32.'
    );
  }

  if (warnings.length > 0) {
    console.warn('[aviso de producao]\n' + warnings.map((w) => `  - ${w}`).join('\n'));
  }

  if (blocking.length > 0) {
    console.error(
      '[configuracao invalida para producao]\n' +
        blocking.map((b) => `  - ${b}`).join('\n')
    );
    process.exit(1);
  }
}

