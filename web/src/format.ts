import type { AccountStatus, JobStatus, TemplateStatus } from './api/types';

export interface Tone {
  tone: 'ok' | 'warn' | 'err' | 'neutral' | 'info';
  label: string;
}

export const jobState = (status: JobStatus): Tone => {
  switch (status) {
    case 'succeeded':
      return { tone: 'ok', label: 'publicado' };
    case 'failed':
      return { tone: 'err', label: 'falhou' };
    case 'running':
      return { tone: 'info', label: 'publicando' };
    case 'queued':
      return { tone: 'neutral', label: 'na fila' };
    case 'cancelled':
      return { tone: 'neutral', label: 'cancelado' };
  }
};

export const accountState = (status: AccountStatus): Tone => {
  switch (status) {
    case 'active':
      return { tone: 'ok', label: 'ativa' };
    case 'pending':
      return { tone: 'warn', label: 'pendente' };
    case 'expired':
      return { tone: 'err', label: 'expirada' };
    case 'revoked':
      return { tone: 'err', label: 'revogada' };
    case 'error':
      return { tone: 'err', label: 'com erro' };
  }
};

/**
 * Cores de status de template.
 *
 * `PENDING` fica em `warn` e nao em `neutral` de proposito: o template pendente
 * e o estado que bloqueia publicacao, e precisa chamar atencao numa lista sem
 * que o operador precisa clicar para descobrir.
 */
export const templateState = (status: TemplateStatus): Tone => {
  switch (status) {
    case 'APPROVED':
      return { tone: 'ok', label: 'aprovado' };
    case 'PENDING':
      return { tone: 'warn', label: 'pendente' };
    case 'REJECTED':
      return { tone: 'err', label: 'reprovado' };
    case 'PAUSED':
      return { tone: 'warn', label: 'pausado' };
    case 'DISABLED':
      return { tone: 'err', label: 'desabilitado' };
  }
};

const dateTimeFormat = new Intl.DateTimeFormat('pt-BR', {
  dateStyle: 'short',
  timeStyle: 'short',
});

export const formatDate = (value: string): string => {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : dateTimeFormat.format(parsed);
};

export const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
};

export const formatSeconds = (seconds: number): string => {
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  if (minutes < 60) return `${minutes}m ${rest}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
};

export const percent = (value: number | null): string =>
  value === null ? '—' : `${(value * 100).toFixed(1)}%`;

/**
 * Converte o input `datetime-local` para ISO UTC com sufixo `Z`.
 *
 * `datetime-local` nao tem fuso, entao o valor precisa ser lido como hora local
 * do navegador e convertido. Sem o `Z` explicito, o zod `.datetime()` do backend
 * rejeita com 400 — a API exige UTC.
 */
export const localInputToIsoUtc = (localValue: string): string | undefined => {
  if (!localValue) return undefined;
  const parsed = new Date(localValue);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return parsed.toISOString();
};

/** O minimo aceito pelo backend e "agora"; um segundo de margem evita race. */
export const isoUtcPlusMinute = (): string => new Date(Date.now() + 60_000).toISOString();

/**
 * Url de midia como o backend a valida: `z.string().url()`, com protocolo http
 * ou https. O painel rejeita no formulario o que a API rejeitaria, para o
 * operador ver o problema no campo e nao num 422.
 */
export const isValidMediaUrl = (value: string): boolean => {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
};

/**
 * Extrai a extensao do path, para avisar antes do agendamento.
 *
 * O pipeline so atravessa `png, jpg, jpeg, gif, webp, mp4` (Fase 8). Uma URL de
 * CDN costuma terminar em token de assinatura em vez de extensao, e o
 * agendamento vai ser recusado com `postiz_media_extension_unsupported` — avisar
 * aqui evita queimar o ciclo de cadastrar-cancelar-republicar.
 */
export const mediaExtension = (value: string): string => {
  try {
    const path = new URL(value).pathname;
    const lastDot = path.lastIndexOf('.');
    if (lastDot <= 0) return '';
    return path.slice(lastDot + 1).toLowerCase();
  } catch {
    return '';
  }
};

export const PIPELINE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'mp4'] as const;

export const extensionCrossesPipeline = (url: string): boolean => {
  const ext = mediaExtension(url);
  // Sem extensao reconhecivel nao da para prever; deixa o backend decidir.
  if (!ext) return false;
  return !(PIPELINE_EXTENSIONS as readonly string[]).includes(ext);
};
