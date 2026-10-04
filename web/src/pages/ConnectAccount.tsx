import { useCallback, useEffect, useRef, useState } from 'react';
import { getOAuthConnectUrl } from '../api';
import { useAction } from '../useAsync';
import { useSession } from '../session';

const CONNECTABLE: { network: string; label: string }[] = [{ network: 'linkedin', label: 'LinkedIn' }];

/**
 * Conectar uma conta pela tela de login da rede.
 *
 * O fluxo e o do mercado: clicar abre a tela do provedor, o usuario loga, e a
 * conta aparece pronta para postar. Nao ha token para colar nem nenhuma segunda
 * etapa em outro lugar -- o callback acontece sozinho numa aba nova.
 *
 * Detalhe que faz a diferenca entre "conectou" e "nao conectou": o painel nao
 * participa do callback. A aba do provedor devolve para o servidor, e o servidor
 * grava a conta. Como o painel nao recebe nenhum evento disso, a lista so
 * atualizaria no proximo F5 -- e o operador-CONCLUI que falhou e clica em
 * conectar de novo, criando uma conta duplicada. Por isso o gancho em
 * `visibilitychange`: quando o usuario volta para esta aba depois de autorizar,
 * recarregamos a lista.
 */
export function ConnectAccount({ onConnected }: { onConnected: () => void }): JSX.Element {
  const { token } = useSession();
  const { run, busy, error } = useAction();
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const waiting = useRef(false);

  const reload = useCallback(() => {
    if (!waiting.current) {
      return;
    }
    waiting.current = false;
    setOpen({});
    onConnected();
  }, [onConnected]);

useEffect(() => {
    // `visibilitychange` e o sinal de que o usuario voltou do provedor. Ouvir
    // `blur` da janela nao serve: clicar dentro da propria aba tambem dispara, e
    // a lista recarregaria sem que a conexao tivesse acontecido.
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') {
        reload();
      }
    };

    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [reload]);

  const connect = async (network: string): Promise<void> => {
    setOpen((state) => ({ ...state, [network]: true }));
    waiting.current = true;

    await run(async () => {
      const response = await getOAuthConnectUrl(token ?? '', network);
      window.open(response.data.authorizeUrl, '_blank', 'noopener,noreferrer');
    });
  };

  return (
    <div className="card">
      <div className="card-title">Conectar conta</div>

      <p className="hint" style={{ marginTop: 0 }}>
        Clique na rede e faça login na tela dela. Ao autorizar, a conta já fica liberada para receber
        campanhas — não é preciso colar token em lugar nenhum.
      </p>

      {error && <div className="alert error">{error}</div>}

      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        {CONNECTABLE.map((item) => (
          <button
            key={item.network}
            type="button"
            className="btn secondary"
            disabled={busy}
            onClick={() => void connect(item.network)}
          >
            {open[item.network] ? `Abrindo ${item.label}…` : `Conectar ${item.label}`}
          </button>
        ))}
      </div>

      <div className="hint">
        Conectar de novo a mesma conta atualiza o acesso — não cria duplicata.
      </div>
    </div>
  );
}
