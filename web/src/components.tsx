import { formatBytes, formatDate, formatSeconds, jobState, accountState, templateState } from './format';
import type { JobStatus, AccountStatus, TemplateStatus } from './api/types';

/** Pill de status generico. `tone` decide a cor, nao o status. */
export const Pill = ({ tone, children }: { tone: 'ok' | 'warn' | 'err' | 'neutral' | 'info'; children: React.ReactNode }): JSX.Element => (
  <span className={`pill ${tone}`}>{children}</span>
);

export const Loading = ({ what = 'dados' }: { what?: string }): JSX.Element => (
  <div className="loading">
    <span className="spinner" /> carregando {what}…
  </div>
);

export const ErrorBox = ({ message, onRetry }: { message: string; onRetry?: () => void }): JSX.Element => (
  <div className="alert error">
    <div>{message}</div>
    {onRetry && (
      <div style={{ marginTop: 8 }}>
        <button className="secondary small" onClick={onRetry}>
          Tentar de novo
        </button>
      </div>
    )}
  </div>
);

export const Empty = ({ children }: { children: React.ReactNode }): JSX.Element => (
  <div className="empty">{children}</div>
);

export const Stat = ({ value, label }: { value: React.ReactNode; label: string }): JSX.Element => (
  <div className="card stat">
    <div className="stat-value">{value}</div>
    <div className="stat-label">{label}</div>
  </div>
);

export const JobPill = ({ status }: { status: JobStatus }): JSX.Element => {
  const state = jobState(status);
  return <Pill tone={state.tone}>{state.label}</Pill>;
};

export const AccountPill = ({ status }: { status: AccountStatus }): JSX.Element => {
  const state = accountState(status);
  return <Pill tone={state.tone}>{state.label}</Pill>;
};

export const TemplatePill = ({ status }: { status: TemplateStatus }): JSX.Element => {
  const state = templateState(status);
  return <Pill tone={state.tone}>{state.label}</Pill>;
};

/**
 * Data e hora no formato do Brasil, com o fuso explicito.
 *
 * Sem o fuso na tela, "agendado para 14:00" e ambiguo entre o fuso do
 * navegador e o UTC que o backend guarda — e o agendamento e a unica coisa que
 * o cliente nao pode ler errado.
 */
export const DateTime = ({ value }: { value: string | null }): JSX.Element => {
  if (!value) return <span style={{ color: 'var(--muted)' }}>—</span>;
  return (
    <span className="mono" title={value}>
      {formatDate(value)}
    </span>
  );
};

export const Bytes = ({ value }: { value: number | null | undefined }): JSX.Element => {
  if (value === null || value === undefined) return <span style={{ color: 'var(--muted)' }}>—</span>;
  return <span className="mono">{formatBytes(value)}</span>;
};

export const Duration = ({ seconds }: { seconds: number | null | undefined }): JSX.Element => {
  if (seconds === null || seconds === undefined) return <span style={{ color: 'var(--muted)' }}>—</span>;
  return <span className="mono">{formatSeconds(seconds)}</span>;
};

/**
 * O id do provedor so vira link depois de reconciliado.
 *
 * Enquanto `releaseIdMissing` e true, `externalPostId` guarda o id INTERNO do
 * Postiz, que nao resolve na rede. Montar um link com ele levaria o operador a
 * uma pagina 404 e a concluir que a publicacao falhou, quando ela deu certo.
 */
export const ExternalId = ({
  value,
  releaseIdMissing,
}: {
  value: string | null;
  releaseIdMissing: boolean;
}): JSX.Element => {
  if (!value) return <span style={{ color: 'var(--muted)' }}>—</span>;
  if (releaseIdMissing) {
    return (
      <span className="mono" style={{ color: 'var(--warn)' }} title="Id interno do Postiz, ainda nao o da rede. Reconcilie para obter o id real.">
        {value} <Pill tone="warn">interno</Pill>
      </span>
    );
  }
  return <span className="mono">{value}</span>;
};

export const Bar = ({ ratio, tone }: { ratio: number; tone: 'ok' | 'warn' | 'err' }): JSX.Element => (
  <div className="bar">
    <div className={tone === 'ok' ? undefined : tone} style={{ width: `${Math.min(100, Math.round(ratio * 100))}%` }} />
  </div>
);
