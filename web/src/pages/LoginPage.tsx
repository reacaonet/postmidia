import { useEffect, useState } from 'react';
import { useSession } from '../session';
import { describeError } from '../api/client';

type Mode = 'login' | 'signup';

/**
 * Login por e-mail e senha; o slug so aparece no cadastro.
 *
 * O painel esconde o slug porque a API resolve a empresa pelo e-mail. O campo
 * continua existindo no login para o caso raro de a mesma senha existir em dois
 * tenants com o mesmo e-mail — nesse caso a API responde 409, e so ai o campo
 * e revelado, porque antes disso ele so confusiria quem nunca ouviu falar de
 * slug.
 */
export default function LoginPage(): JSX.Element {
  const { login, signup, expired, clearExpired } = useSession();
  const [mode, setMode] = useState<Mode>('login');
  const [slug, setSlug] = useState('');
  const [askSlug, setAskSlug] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [tenantName, setTenantName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [signupOff, setSignupOff] = useState(false);

  // Um 401 recebido em outra tela (token expirado) precisa aparecer aqui; sem
  // isso a pessoa cairia aqui sem entender o motivo.
  useEffect(() => {
    if (expired) {
      setError('Sessao encerrada: o token expirou ou as credenciais estavam erradas. Entre de novo.');
      clearExpired();
    }
  }, [expired, clearExpired]);

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === 'login') {
        // Sem slug enquanto o campo estiver escondido: manda-lo vazio deixaria
        // a API procurar por `slug = ''` e recusar com 400 em vez de 401.
        await login({ email, password, ...(askSlug && slug ? { slug } : {}) });
      } else {
        await signup({ tenantName, slug, email, password });
      }
    } catch (err: unknown) {
      const message = describeError(err);
      setError(message);
      // O 403 do signup desligado e de configuracao do servidor, e nao erro de
      // digitacao. Dizer isso evita a pessoa tentando outra senha.
      if (message.includes('Signup desabilitado')) {
        setSignupOff(true);
      }
      // 409 aqui so acontece no login ambiguo: mesmo e-mail e mesma senha em
      // empresas diferentes. Revelar o campo resolve.
      if (mode === 'login' && message.includes('mais de uma empresa')) {
        setAskSlug(true);
      }
    } finally {
      setBusy(false);
    }
  };

  const switchMode = (next: Mode): void => {
    setMode(next);
    setError(null);
    setSignupOff(false);
    setAskSlug(false);
  };

  return (
    <div className="login-shell">
      <div className="login-box">
        <div className="card">
          <h1 className="page-title">postmidia</h1>
          <p className="page-sub">
            {mode === 'login' ? 'Entre com seu e-mail e senha.' : 'Crie uma empresa e o usuário dono.'}
          </p>

          {error && <div className="alert error">{error}</div>}
          {signupOff && (
            <div className="alert info">
              O cadastro público está desligado neste ambiente.{' '}
              <code>ALLOW_SELF_SIGNUP=true</code> no <code>.env</code> habilita. Sem isso, a empresa precisa ser
              provisionada por migration.
            </div>
          )}

          <form onSubmit={submit}>
            {mode === 'signup' && (
              <>
                <label>
                  <span>Nome da empresa</span>
                  <input
                    value={tenantName}
                    onChange={(e) => setTenantName(e.target.value)}
                    required
                    minLength={2}
                    maxLength={120}
                    placeholder="Minha Loja"
                  />
                </label>

                <label>
                  <span>Identificador da empresa (slug)</span>
                  <input
                    value={slug}
                    onChange={(e) => setSlug(e.target.value.toLowerCase())}
                    required
                    minLength={3}
                    maxLength={63}
                    pattern="[a-z0-9]([a-z0-9\-]*[a-z0-9])?"
                    placeholder="minha-loja"
                    autoComplete="organization"
                  />
                  <div className="hint">
                    Identificador da empresa. Precisa ser único e é usado como endereço interno.
                  </div>
                </label>
              </>
            )}

            {mode === 'login' && askSlug && (
              <label>
                <span>Identificador da empresa</span>
                <input
                  value={slug}
                  onChange={(e) => setSlug(e.target.value.toLowerCase())}
                  required
                  minLength={3}
                  maxLength={63}
                  pattern="[a-z0-9]([a-z0-9\-]*[a-z0-9])?"
                  placeholder="minha-loja"
                />
                <div className="hint">
                  A mesma senha foi encontrada em duas empresas com este e-mail. Informe qual.
                </div>
              </label>
            )}

            <label>
              <span>E-mail</span>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
                placeholder="voce@empresa.com"
              />
            </label>

            <label>
              <span>Senha</span>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={mode === 'signup' ? 10 : 1}
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              />
              {mode === 'signup' && (
                <div className="hint">
                  Mínimo 10 caracteres, com pelo menos uma letra e um número.
                </div>
              )}
            </label>

            <button type="submit" disabled={busy} style={{ width: '100%' }}>
              {busy ? <span className="spinner" /> : mode === 'login' ? 'Entrar' : 'Criar empresa'}
            </button>
          </form>
        </div>

        <div className="card" style={{ textAlign: 'center' }}>
          {mode === 'login' ? (
            <>
              Ainda não tem empresa?{' '}
              <a
                href="#signup"
                onClick={(e) => {
                  e.preventDefault();
                  switchMode('signup');
                }}
              >
                Criar agora
              </a>
            </>
          ) : (
            <>
              Já tem empresa?{' '}
              <a
                href="#login"
                onClick={(e) => {
                  e.preventDefault();
                  switchMode('login');
                }}
              >
                Entrar
              </a>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
