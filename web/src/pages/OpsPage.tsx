import { useState } from 'react';
import { getMetrics } from '../api';
import { describeError } from '../api/client';
import type { OpsMetrics } from '../api/types';
import { Bar, DateTime, Duration, Empty, ErrorBox, Loading, Pill, Stat } from '../components';
import { percent } from '../format';

const TOKEN_KEY = 'postmidia.opsToken';

/**
 * O painel operacional e uma porta separada, com segredo separado.
 *
 * `owner` e papel POR TENANT, entao proteger esta rota com ele mostraria a fila
 * inteira para o dono de qualquer loja. O backend usa `x-metrics-token` e
 * falha fechada (503) sem token. O painel mantem o token em `sessionStorage`,
 * pelo mesmo motivo do JWT: sobreviver ao fechamento do navegador transformaria
 * um XSS em acesso de plataforma permanente.
 *
 * `503` aqui significa "METRICS_TOKEN nao configurado no servidor" — nao e erro
 * de digitacao, e por isso a mensagem e separada do erro de token invalido.
 */
export default function OpsPage(): JSX.Element {
  const [token, setToken] = useState(() => sessionStorage.getItem(TOKEN_KEY) ?? '');
  const [windowHours, setWindowHours] = useState(24);
  const [tenantId, setTenantId] = useState('');
  const [metrics, setMetrics] = useState<OpsMetrics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notConfigured, setNotConfigured] = useState(false);
  const [loading, setLoading] = useState(false);

  const load = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setError(null);
    setNotConfigured(false);
    setLoading(true);
    sessionStorage.setItem(TOKEN_KEY, token);
    try {
      const result = await getMetrics({
        token,
        windowHours,
        tenantId: tenantId.trim() || undefined,
      });
      setMetrics(result.data);
    } catch (err: unknown) {
      const status = (err as { status?: number }).status;
      setMetrics(null);
      if (status === 503) {
        setNotConfigured(true);
      } else if (status === 401) {
        setError('Token de plataforma inválido ou ausente. Confira o METRICS_TOKEN do servidor.');
      } else {
        setError(describeError(err));
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <h1 className="page-title">Painel operacional</h1>
      <p className="page-sub">
        Leitura de plataforma: atravessa todos os clientes. Não aceita o JWT de tenant — usa o
        <code> METRICS_TOKEN</code> do servidor.
      </p>

      <div className="card">
        <form onSubmit={load}>
          <div className="row">
            <label style={{ flex: 2 }}>
              <span>Token de plataforma</span>
              <input
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                required
                placeholder="METRICS_TOKEN"
                autoComplete="off"
              />
            </label>
            <label>
              <span>Janela (horas)</span>
              <input
                type="number"
                min={1}
                max={720}
                value={windowHours}
                onChange={(e) => setWindowHours(Number(e.target.value))}
              />
            </label>
            <label style={{ flex: 2 }}>
              <span>Tenant (opcional)</span>
              <input
                value={tenantId}
                onChange={(e) => setTenantId(e.target.value)}
                placeholder="uuid — vazio = todos os clientes"
                className="mono"
              />
              <div className="hint">Com tenant, a leitura passa a ser comum (RLS de tenant) e mostra o nome.</div>
            </label>
            <button type="submit" disabled={loading}>
              {loading ? <span className="spinner" /> : 'Consultar'}
            </button>
          </div>
        </form>
      </div>

      {notConfigured && (
        <div className="alert warn">
          <strong>Painel desabilitado no servidor.</strong> Defina <code>METRICS_TOKEN</code> (mínimo 32
          caracteres) no <code>.env</code>. A rota falha fechada por desenho: sem token ela não responde nada, para
          não virar uma leitura cross-tenant aberta.
        </div>
      )}
      {error && <ErrorBox message={error} />}

      {loading && <Loading what="métricas" />}

      {!loading && metrics && <Metrics metrics={metrics} />}
      {!loading && !metrics && !error && !notConfigured && (
        <Empty>Informe o token de plataforma para consultar.</Empty>
      )}
    </>
  );
}

const Metrics = ({ metrics }: { metrics: OpsMetrics }): JSX.Element => {
  const totalJobs = Object.values(metrics.byStatus).reduce((sum, n) => sum + n, 0);
  const alertTone = metrics.alerts.postizQuota === 'ok' ? 'ok' : metrics.alerts.postizQuota === 'warning' ? 'warn' : 'err';

  return (
    <>
      <div className="alert info">
        Janela de {metrics.windowHours}h, gerada em <DateTime value={metrics.generatedAt} />
        {metrics.tenantName ? (
          <>
            {' '}
            — tenant <strong>{metrics.tenantName}</strong>
          </>
        ) : (
          <> — visão agregada de todos os clientes</>
        )}
      </div>

      {metrics.alerts.blocking && (
        <div className="alert error">
          <strong>Cota do Postiz esgotada.</strong> As publicações vão falhar até a cota liberar. O upload tem
          limite menor que o de posts, então esgota primeiro.
        </div>
      )}

      <div className="grid grid-4">
        <Stat value={totalJobs} label="Jobs no total" />
        <Stat value={metrics.openDeadLetters} label="Fila morta aberta" />
        <Stat value={metrics.pendingReconciliation} label="Aguardando reconciliação" />
        <Stat value={metrics.latency.samples} label="Amostras de latência" />
      </div>

      <div className="card">
        <div className="card-title">
          <span>Cota do Postiz</span>
          <Pill tone={alertTone}>{metrics.alerts.postizQuota}</Pill>
        </div>
        {metrics.postizQuota.map((bucket) => (
          <div key={bucket.bucket} style={{ marginBottom: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
              <span>
                <strong>{bucket.bucket === 'posts' ? 'Publicações' : 'Uploads'}</strong>{' '}
                <span style={{ color: 'var(--muted)' }}>
                  {bucket.used}/{bucket.limit} por hora
                </span>
              </span>
              <span>
                {bucket.remaining} restantes · {percent(bucket.ratio)}
              </span>
            </div>
            <Bar
              ratio={bucket.ratio}
              tone={bucket.state === 'ok' ? 'ok' : bucket.state === 'warning' ? 'warn' : 'err'}
            />
            {!bucket.tracked && (
              <div className="hint">
                Contador em memória: sem Redis, então não sobrevive a reinício e não é compartilhado entre
                réplicas.
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="grid grid-2">
        <div className="card">
          <div className="card-title">Latência de publicação</div>
          <div className="grid grid-4" style={{ gap: 10 }}>
            <Stat value={<Duration seconds={metrics.latency.p50Seconds} />} label="p50" />
            <Stat value={<Duration seconds={metrics.latency.p95Seconds} />} label="p95" />
            <Stat value={<Duration seconds={metrics.latency.maxSeconds} />} label="máx" />
          </div>
          <div className="hint">
            Mede da data agendada até a publicação concluída. É a latência que o cliente sente, não a duração do
            job.
          </div>
        </div>

        <div className="card">
          <div className="card-title">Jobs por status</div>
          <table>
            <tbody>
              {Object.entries(metrics.byStatus).length === 0 && (
                <tr>
                  <td>
                    <span style={{ color: 'var(--muted)' }}>Nenhum job registrado.</span>
                  </td>
                </tr>
              )}
              {Object.entries(metrics.byStatus).map(([status, count]) => (
                <tr key={status}>
                  <td>{status}</td>
                  <td className="mono" style={{ textAlign: 'right' }}>
                    {count}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <div className="card-title">Desempenho por rede</div>
        <table>
          <thead>
            <tr>
              <th>Rede</th>
              <th>Total</th>
              <th>Publicados</th>
              <th>Falhas</th>
              <th>Taxa de falha</th>
            </tr>
          </thead>
          <tbody>
            {metrics.byNetwork.length === 0 && (
              <tr>
                <td colSpan={5}>
                  <span style={{ color: 'var(--muted)' }}>Sem jobs no período.</span>
                </td>
              </tr>
            )}
            {metrics.byNetwork.map((row) => (
              <tr key={row.network}>
                <td>
                  <strong>{row.network}</strong>
                </td>
                <td className="mono">{row.total}</td>
                <td className="mono">{row.succeeded}</td>
                <td className="mono">{row.failed}</td>
                <td>
                  {row.failureRate === null ? (
                    <span style={{ color: 'var(--muted)' }}>—</span>
                  ) : (
                    <span
                      className="mono"
                      style={{
                        color:
                          row.failureRate > 0.2 ? 'var(--err)' : row.failureRate > 0.05 ? 'var(--warn)' : 'var(--ok)',
                      }}
                    >
                      {percent(row.failureRate)}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
};
