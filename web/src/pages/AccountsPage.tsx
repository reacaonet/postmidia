import { useState } from 'react';
import {
  createAccount,
  getAccountSettings,
  getAccounts,
  getNetworks,
  syncAccountSpecs,
} from '../api';
import type { ChannelAccount, NetworkSpec } from '../api/types';
import { useAsync, useAction } from '../useAsync';
import { useSession } from '../session';
import { AccountPill, DateTime, Empty, ErrorBox, Loading, Pill } from '../components';

export default function AccountsPage(): JSX.Element {
  const { token, canWrite } = useSession();
  const [selected, setSelected] = useState<ChannelAccount | null>(null);

  const accounts = useAsync(() => getAccounts(token ?? ''), [token]);
  const networks = useAsync(() => getNetworks(), []);

  const specs = (networks.data?.data.specs ?? {}) as Record<string, NetworkSpec>;

  return (
    <>
      <h1 className="page-title">Contas de redes sociais</h1>
      <p className="page-sub">
        Cada conta guarda o token da rede, cifrado no banco. O token nunca volta em resposta de API.
      </p>

      {canWrite ? (
        <NewAccountForm specs={specs} onCreated={accounts.reload} />
      ) : (
        <div className="alert info">
          Seu papel é <strong>member</strong>: você pode consultar, mas não criar nem sincronizar. Peça a um
          owner ou admin.
        </div>
      )}

      <div className="card">
        <div className="card-title">
          <span>Contas cadastradas</span>
          {accounts.data && <Pill tone="neutral">{accounts.data.data.length}</Pill>}
        </div>

        {accounts.loading && <Loading what="contas" />}
        {accounts.error && <ErrorBox message={accounts.error} onRetry={accounts.reload} />}

        {!accounts.loading && !accounts.error && accounts.data?.data.length === 0 && (
          <Empty>
            Nenhuma conta ainda. Cadastre a primeira acima para poder agendar publicações.
          </Empty>
        )}

        {accounts.data && accounts.data.data.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Rede</th>
                <th>Nome</th>
                <th>Id na rede</th>
                <th>Status</th>
                <th>Limite de texto</th>
                <th>Specs sincronizados</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {accounts.data.data.map((account) => {
                const spec = specs[account.network];
                const effective = account.providerMaxLength ?? spec?.text.maxChars ?? null;
                return (
                  <tr key={account.id}>
                    <td>
                      <strong>{spec?.label ?? account.network}</strong>
                    </td>
                    <td>{account.displayName}</td>
                    <td className="mono">{account.externalAccountId}</td>
                    <td>
                      <AccountPill status={account.status} />
                    </td>
                    <td className="mono">
                      {effective ?? '—'}
                      {account.providerMaxLength === null && spec ? (
                        <div className="hint" style={{ marginTop: 2 }}>
                          fallback local
                        </div>
                      ) : null}
                    </td>
                    <td>
                      <DateTime value={account.specsSyncedAt} />
                    </td>
                    <td>
                      <div className="actions">
                        <button className="secondary small" onClick={() => setSelected(account)}>
                          Detalhes
                        </button>
                        {canWrite && (
                          <SyncButton account={account} onSynced={accounts.reload} />
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {selected && <AccountDetails account={selected} onClose={() => setSelected(null)} />}
    </>
  );
}

/**
 * Sincronizar os specs com o Postiz.
 *
 * O erro 502 traz `detail` alem da mensagem, e ele importa: a mensagem diz
 * "provedor indisponivel, cache anterior preservado" e o `detail` diz o que
 * deu errado de fato (token ausente do Postiz, 404 na rota, rede fora). Sem o
 * detail, o operador so sabe que "alguma coisa" falhou.
 */
function SyncButton({ account, onSynced }: { account: ChannelAccount; onSynced: () => void }): JSX.Element {
  const { token } = useSession();
  const { run, busy, error } = useAction();
  return (
    <>
      <button
        className="secondary small"
        disabled={busy}
        onClick={() =>
          run(async () => {
            // O token vem da sessao, nunca de um literal: sem ele a API devolve
            // 401 e o painel inteiro interpreta como "sessao expirada".
            await syncAccountSpecs(token ?? '', account.id);
            onSynced();
          }).then((ok) => {
            if (ok) {
              onSynced();
            }
          })
        }
      >
        {busy ? <span className="spinner" /> : 'Sincronizar specs'}
      </button>
      {error && (
        <div className="alert error" style={{ marginTop: 6, marginBottom: 0, fontSize: 12 }}>
          {error}
        </div>
      )}
    </>
  );
}

const NewAccountForm = ({
  specs,
  onCreated,
}: {
  specs: Record<string, NetworkSpec>;
  onCreated: () => void;
}): JSX.Element => {
  const { token } = useSession();
  const { run, busy, error } = useAction();
  const [network, setNetwork] = useState('instagram');
  const [displayName, setDisplayName] = useState('');
  const [externalAccountId, setExternalAccountId] = useState('');
  const [secret, setSecret] = useState('');
  const [done, setDone] = useState<string | null>(null);

  const spec = specs[network];
  const bridged = spec ? !spec.features.twoStepPublish === false : false;

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setDone(null);
    await run(async () => {
      await createAccount(token ?? '', {
        network,
        externalAccountId,
        displayName,
        secret,
      });
      setDisplayName('');
      setExternalAccountId('');
      setSecret('');
      onCreated();
      setDone('Conta cadastrada. Se a rede é integrada ao Postiz, o header X-Provider-Specs pode avisar que os limites caíram no fallback local.');
    });
  };

  return (
    <div className="card">
      <div className="card-title">Cadastrar conta</div>

      {error && <div className="alert error">{error}</div>}
      {done && <div className="alert ok">{done}</div>}

      <form onSubmit={submit}>
        <div className="row">
          <label>
            <span>Rede</span>
            <select value={network} onChange={(e) => setNetwork(e.target.value)}>
              {Object.values(specs).map((item) => (
                <option key={item.network} value={item.network}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>

          <label>
            <span>Nome de exibição</span>
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              required
              placeholder="Minha conta do Instagram"
            />
          </label>

          <label>
            <span>Id da conta na rede</span>
            <input
              value={externalAccountId}
              onChange={(e) => setExternalAccountId(e.target.value)}
              required
              placeholder={network === 'whatsapp' ? 'phone-number id' : 'id retornado pela rede'}
            />
          </label>
        </div>

        <label>
          <span>Token de acesso</span>
          <input
            type="password"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            required
            placeholder="token da rede"
            autoComplete="off"
          />
          <div className="hint">
            Cifrado com AES-256-GCM antes de ir ao banco. Não é retornado em nenhuma resposta.
            {network === 'whatsapp' && ' Para WhatsApp, é o token da Graph API.'}
          </div>
        </label>

        {spec && (
          <div className="alert info" style={{ fontSize: 12 }}>
            Limite local de texto: <strong>{spec.text.maxChars}</strong> caracteres.
            {bridged
              ? ' Esta rede é integrada pelo Postiz: ao cadastrar, o servidor tenta aprender o limite real do provedor e, se falhar, usa este.'
              : ' Rede nativa: o limite vem daqui e não há sincronização de provedor.'}
          </div>
        )}

        <button type="submit" disabled={busy}>
          {busy ? <span className="spinner" /> : 'Cadastrar'}
        </button>
      </form>
    </div>
  );
};

const AccountDetails = ({ account, onClose }: { account: ChannelAccount; onClose: () => void }): JSX.Element => {
  const { token } = useSession();
  const settings = useAsync(() => getAccountSettings(token ?? '', account.id), [token, account.id]);

  return (
    <div className="card">
      <div className="card-title">
        <span>
          {account.displayName} — <span className="mono">{account.network}</span>
        </span>
        <button className="secondary small" onClick={onClose}>
          Fechar
        </button>
      </div>

      <pre className="detail mono">{JSON.stringify(account, null, 2)}</pre>

      {settings.loading && <Loading what="configuração da integração" />}
      {settings.error && <ErrorBox message={settings.error} onRetry={settings.reload} />}
      {settings.data && (
        <pre className="detail mono">{JSON.stringify(settings.data.data, null, 2)}</pre>
      )}
    </div>
  );
};
