import { useCallback, useEffect, useRef, useState } from 'react';
import { describeError } from './api/client';
import { consumeUnauthorized } from './session';

/**
 * Carrega dado da API com estado de erro e recarga manual.
 *
 * O `consumeUnauthorized` no `catch` e o que evita o pior sintoma de um token
 * expirado: sem ele, cada tela mostrava o seu proprio "Erro interno" e o
 * operador ficava recarregando paginas sem entender que a sessao tinha
 * terminado.
 *
 * `reload` e estavel de proposito — e dependencia de `useEffect` em varias
 * telas, e uma funcao nova a cada render causaria busca infinita.
 */
export function useAsync<T>(
  loader: () => Promise<T>,
  deps: unknown[]
): { data: T | null; error: string | null; loading: boolean; reload: () => void; setData: (v: T | null) => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  // Guarda o loader em ref para que a funcao nao entre como dependencia: as
  // telas passam lambdas inline como `() => api.get(...)`, que sao identicas a
  // cada render.
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    setLoading(true);
    loaderRef
      .current()
      .then((value) => {
        if (!alive.current) return;
        setData(value);
        setError(null);
      })
      .catch((err: unknown) => {
        if (!alive.current) return;
        if (consumeUnauthorized(err)) return;
        setError(describeError(err));
      })
      .finally(() => {
        if (alive.current) setLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  return { data, error, loading, reload, setData };
}

/**
 * Estado para acoes de escrita (criar, sincronizar, resolver).
 *
 * Separado de `useAsync` porque a semantica e outra: uma escrita bem-sucedida
 * quase sempre precisa recarregar a lista, e a UI precisa de "carregando" e de
 * "feito" — nao de "carregando a lista".
 */
export function useAction(): {
  run: (fn: () => Promise<void>) => Promise<boolean>;
  busy: boolean;
  error: string | null;
  clear: () => void;
} {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async (fn: () => Promise<void>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      return true;
    } catch (err: unknown) {
      if (!consumeUnauthorized(err)) {
        setError(describeError(err));
      }
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  return { run, busy, error, clear: () => setError(null) };
}
