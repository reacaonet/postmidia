import { useState } from 'react';
import { getAudit } from '../api';
import type { AuditEntry } from '../api/types';
import { useAsync } from '../useAsync';
import { useSession } from '../session';
import { DateTime, Empty, ErrorBox, Loading, Pill } from '../components';

/**
 * `GET /audit` fica na raiz da API, nao sob `/auth`. O router de auth foi
 * montado sem prefixo, entao o caminho real e `/audit` — erro comum e `404`
 * que so aparece quando a tela e aberta.
 */
export default function AuditPage(): JSX.Element {
  const { token } = useSession();
  const [limit, setLimit] = useState(100);
  const audit = useAsync(() => getAudit(token ?? '', limit), [token, limit]);

  return (
    <>
      <h1 className="page-title">Auditoria</h1>
      <p className="page-sub">Quem fez o quê, com o valor anterior e o novo quando a ação muda estado.</p>

      <div className="card">
        <div className="row">
          <label style={{ maxWidth: 200 }}>
            <span>Quantidade</span>
            <select value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
              <option value={50}>50</option>
              <option value={100}>100</option>
              <option value={250}>250</option>
              <option value={500}>500</option>
            </select>
          </label>
        </div>
      </div>

      <div className="card">
        {audit.loading && <Loading what="auditoria" />}
        {audit.error && <ErrorBox message={audit.error} onRetry={audit.reload} />}
        {!audit.loading && !audit.error && audit.data?.data.length === 0 && (
          <Empty>Nenhum registro de auditoria ainda.</Empty>
        )}
        {audit.data && audit.data.data.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Quando</th>
                <th>Ação</th>
                <th>Ator</th>
                <th>Detalhe</th>
              </tr>
            </thead>
            <tbody>
              {audit.data.data.map((entry) => (
                <Row key={entry.id} entry={entry} />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

const Row = ({ entry }: { entry: AuditEntry }): JSX.Element => (
  <tr>
    <td>
      <DateTime value={entry.createdAt} />
    </td>
    <td>
      <Pill tone="info">{entry.action}</Pill>
    </td>
    <td>
      {entry.actorEmail ?? <span style={{ color: 'var(--muted)' }}>sistema</span>}
      <div className="hint mono">{entry.entityType}</div>
    </td>
    <td>
      <Metadata metadata={entry.metadata} />
    </td>
  </tr>
);

/**
 * `metadata` e `Record<string, unknown>` livre, e o valor que importa esta no
 * `from`/`to` da mudanca de status. Mostrar so pares simples e highlightar
 * transicoes evita despejar um JSON opaco na tela.
 */
const Metadata = ({ metadata }: { metadata: Record<string, unknown> }): JSX.Element => {
  const keys = Object.keys(metadata ?? {});
  if (keys.length === 0) {
    return <span style={{ color: 'var(--muted)' }}>—</span>;
  }
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      {keys.map((key) => {
        const value = metadata[key];
        const isTransition = key === 'from' || key === 'to';
        return (
          <span key={key} className="mono" style={{ fontSize: 12 }}>
            <span style={{ color: 'var(--muted)' }}>{key}:</span>{' '}
            <strong style={isTransition ? { color: 'var(--accent)' } : undefined}>
              {typeof value === 'object' ? JSON.stringify(value) : String(value)}
            </strong>
          </span>
        );
      })}
    </div>
  );
};
