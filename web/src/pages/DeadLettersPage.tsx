import { useState } from 'react';
import { getDeadLetters, resolveDeadLetter } from '../api';
import type { DeadLetterJob } from '../api/types';
import { useAsync, useAction } from '../useAsync';
import { useSession } from '../session';
import { DateTime, Empty, ErrorBox, Loading, Pill } from '../components';
import { jobState } from '../format';

type Filter = 'open' | 'requeued' | 'discarded' | 'all';

const FILTERS: Array<{ value: Filter; label: string }> = [
  { value: 'open', label: 'Abertas' },
  { value: 'requeued', label: 'Reagendadas' },
  { value: 'discarded', label: 'Descartadas' },
  { value: 'all', label: 'Todas' },
];

export default function DeadLettersPage(): JSX.Element {
  const { token, canWrite } = useSession();
  const [filter, setFilter] = useState<Filter>('open');
  const [notice, setNotice] = useState<string | null>(null);

  // "all" nao vai como parametro: o backend trata `resolution` ausente como
  // todas, e mandar "all" nao casaria com o enum e o zod devolveria 400.
  const deadLetters = useAsync(
    () => getDeadLetters(token ?? '', filter === 'all' ? {} : { resolution: filter }),
    [token, filter]
  );

  const entries = deadLetters.data?.data ?? [];
  const openCount = entries.filter((entry) => entry.resolution === null).length;

  return (
    <>
      <h1 className="page-title">Fila morta</h1>
      <p className="page-sub">
        Jobs que esgotaram as tentativas. Reagendar zera as tentativas e devolve o job para a fila; descartar
        encerra sem republicar.
      </p>

      {notice && (
        <div className="alert ok">
          {notice}
          <button className="secondary small" style={{ marginLeft: 10 }} onClick={() => setNotice(null)}>
            Fechar
          </button>
        </div>
      )}

      <div className="card">
        <div className="actions">
          {FILTERS.map((item) => (
            <button
              key={item.value}
              className={filter === item.value ? 'small' : 'secondary small'}
              onClick={() => setFilter(item.value)}
            >
              {item.label}
            </button>
          ))}
          <span style={{ marginLeft: 'auto', color: 'var(--muted)', fontSize: 12 }}>
            {filter === 'open' ? `${openCount} em aberto` : `${entries.length} no filtro`}
          </span>
        </div>
      </div>

      <div className="card">
        {deadLetters.loading && <Loading what="fila morta" />}
        {deadLetters.error && <ErrorBox message={deadLetters.error} onRetry={deadLetters.reload} />}
        {!deadLetters.loading && !deadLetters.error && entries.length === 0 && (
          <Empty>
            {filter === 'open'
              ? 'Nenhuma entrada aberta. Nada esgotou as tentativas.'
              : 'Nenhuma entrada neste filtro.'}
          </Empty>
        )}

        {entries.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Rede</th>
                <th>Destinatário</th>
                <th>Tentativas</th>
                <th>Último erro</th>
                <th>Código</th>
                <th>Reagendamentos</th>
                <th>Situação</th>
                <th>Quando</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <Row
                  key={entry.id}
                  entry={entry}
                  canWrite={canWrite}
                  onResolved={(message) => {
                    setNotice(message);
                    deadLetters.reload();
                  }}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

const Row = ({
  entry,
  canWrite,
  onResolved,
}: {
  entry: DeadLetterJob;
  canWrite: boolean;
  onResolved: (message: string) => void;
}): JSX.Element => {
  const { token } = useSession();
  const { run, busy, error } = useAction();

  const requeue = () =>
    run(async () => {
      await resolveDeadLetter(token ?? '', entry.id, 'requeue');
      onResolved('Entrada reagendada: as tentativas foram zeradas e o job voltou para a fila.');
    });

  const discard = () =>
    run(async () => {
      await resolveDeadLetter(token ?? '', entry.id, 'discard');
      onResolved('Entrada descartada. O job não foi republicado.');
    });

  return (
    <tr>
      <td>
        <Pill tone="info">{entry.network}</Pill>
      </td>
      <td className="mono">{entry.recipient ?? '—'}</td>
      <td className="mono">{entry.attempts}</td>
      <td style={{ maxWidth: 320 }}>
        {entry.lastError ?? <span style={{ color: 'var(--muted)' }}>—</span>}
      </td>
      <td className="mono">{entry.lastErrorCode ?? '—'}</td>
      <td className="mono">{entry.requeueCount}</td>
      <td>
        {entry.resolution === null ? (
          <Pill tone="warn">aberta</Pill>
        ) : (
          <Pill tone={jobState('succeeded').tone}>{entry.resolution}</Pill>
        )}
      </td>
      <td>
        <DateTime value={entry.createdAt} />
      </td>
      <td>
        {entry.resolution === null && canWrite ? (
          <div className="actions">
            <button className="small" disabled={busy} onClick={requeue}>
              Reagendar
            </button>
            <button className="secondary small" disabled={busy} onClick={discard}>
              Descartar
            </button>
          </div>
        ) : entry.resolution !== null ? (
          <span style={{ color: 'var(--muted)', fontSize: 12 }}>tratada</span>
        ) : (
          <span style={{ color: 'var(--muted)', fontSize: 12 }}>somente owner/admin</span>
        )}
        {error && (
          <div className="alert error" style={{ marginTop: 6, marginBottom: 0, fontSize: 12 }}>
            {error}
          </div>
        )}
      </td>
    </tr>
  );
};
