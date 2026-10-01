import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { login as apiLogin, me, signup as apiSignup } from './api';
import { ApiError } from './api/client';
import type { Role, TenantRef } from './api/types';

/**
 * Sessao do cliente.
 *
 * **O token vai para `sessionStorage`, nao `localStorage`.** A diferenca importa:
 * `localStorage` sobrevive ao fechar o navegador, entao um XSS em qualquer
 * pagina da mesma origem ficaria com o token do tenant disponivel para sempre.
 * `sessionStorage` morre com a aba, e o custo e repassar email/senha apos um
 * restart — preco justo para um token que da acesso a contas de redes sociais.
 *
 * Nao ha refresh token na API: `JWT_TTL` e 12h por padrao e expirado o token
 * morre. O `onUnauthorized` abaixo trata isso expirando a sessao em vez de
 * deixar a tela mostrar erro de 401 em cada tela.
 */

const TOKEN_KEY = 'postmidia.token';
const USER_KEY = 'postmidia.user';
const TENANT_KEY = 'postmidia.tenant';

export interface Session {
  token: string | null;
  user: { email: string; role: Role } | null;
  tenant: TenantRef | null;
}

export interface SessionValue extends Session {
  login: (input: { slug: string; email: string; password: string }) => Promise<void>;
  signup: (input: {
    tenantName: string;
    slug: string;
    email: string;
    password: string;
  }) => Promise<void>;
  logout: () => void;
  /** true quando o token expirou e a sessao foi encerrada. */
  expired: boolean;
  clearExpired: () => void;
  /** Encerra a sessao marcando expiracao, para a tela de login explicar. */
  expire: () => void;
  canWrite: boolean;
}

const SessionContext = createContext<SessionValue | null>(null);

const readJson = <T,>(key: string): T | null => {
  try {
    const raw = sessionStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    // JSON corrompido nao pode impedir o painel de carregar: um storage cheio
    // ou adulterado custaria a pessoa a Ability de entrar.
    return null;
  }
};

const readToken = (): string | null => {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
};

export const SessionProvider = ({ children }: { children: ReactNode }): JSX.Element => {
  const [token, setToken] = useState<string | null>(readToken);
  const [user, setUser] = useState<Session['user']>(() => readJson<Session['user']>(USER_KEY));
  const [tenant, setTenant] = useState<TenantRef | null>(() => readJson<TenantRef>(TENANT_KEY));
  const [expired, setExpired] = useState(false);

  const persist = useCallback((nextToken: string, nextUser: Session['user'], nextTenant: TenantRef | null) => {
    sessionStorage.setItem(TOKEN_KEY, nextToken);
    sessionStorage.setItem(USER_KEY, JSON.stringify(nextUser));
    if (nextTenant) {
      sessionStorage.setItem(TENANT_KEY, JSON.stringify(nextTenant));
    }
    setToken(nextToken);
    setUser(nextUser);
    setTenant(nextTenant);
    setExpired(false);
  }, []);

  const logout = useCallback(() => {
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(USER_KEY);
    sessionStorage.removeItem(TENANT_KEY);
    setToken(null);
    setUser(null);
    setTenant(null);
  }, []);

  /**
   * Encerra a sessao por 401, mantendo a flag `expired` para que a tela de login
   * explique o motivo. O 401 nao e sempre expiracao (`POST /auth/login` com
   * senha errada tambem devolve 401), mas para quem esta na tela de login o
   * efeito e o mesmo: a mensagem especifica ja foi mostrada pelo formulario.
   */
  const expire = useCallback(() => {
    setExpired(true);
    logout();
  }, [logout]);

  const login = useCallback(
    async (input: { slug: string; email: string; password: string }) => {
      const result = await apiLogin(input);
      const rawUser = result.data.user as { email: string; role: Role };
      persist(result.data.token, { email: rawUser.email, role: rawUser.role }, null);
      // O tenant so aparece no signup. No login ele vem do `me`, que le do
      // token — entao buscamos depois para a barra superior mostrar o nome.
      try {
        const profile = await me(result.data.token);
        const slugFromEmail = input.slug;
        setTenant({ id: profile.data.tenantId, name: slugFromEmail, slug: slugFromEmail });
      } catch {
        // Falhar no `me` nao pode derrubar um login valido: o token ja esta
        // guardado e as telas funcionam com o tenantId.
      }
    },
    [persist]
  );

  const signup = useCallback(
    async (input: { tenantName: string; slug: string; email: string; password: string }) => {
      const result = await apiSignup(input);
      const rawUser = result.data.user as { email: string; role: Role };
      const rawTenant = result.data.tenant as TenantRef;
      persist(result.data.token, { email: rawUser.email, role: rawUser.role }, rawTenant);
    },
    [persist]
  );

  const value = useMemo<SessionValue>(
    () => ({
      token,
      user,
      tenant,
      login,
      signup,
      logout,
      expired,
      expire,
      clearExpired: () => setExpired(false),
      // `member` nunca faz mutacao no backend. Reproduzir a regra aqui evita
      // mostrar botoes que vao devolver 403 — mas continua NAO sendo seguranca:
      // o backend e que barra, e o painel so esconde o que ja seria recusado.
      canWrite: user?.role === 'owner' || user?.role === 'admin',
    }),
    [token, user, tenant, login, signup, logout, expired, expire]
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
};

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) {
    throw new Error('useSession precisa estar dentro de SessionProvider');
  }
  return value;
}

export { handleUnauthorizedRef };
/**
 * Ponte entre o `SessionProvider` e o tratamento de 401 das telas.
 *
 * O provider nao pode ser importado pelos hooks de tela sem criar ciclo com
 * `App`, entao o `logout` fica num modulo-level ref que `App` preenche. Sem
 * isto, cada tela precisaria try/catch de 401 por chamada, e um token expirado
 * apareceria como erro de rede em cinco lugares diferentes.
 */
const handleUnauthorizedRef: { current: (() => void) | null } = { current: null };

/** Chamado por `App` uma vez, para que 401 em qualquer tela encerre a sessao. */
export const bindUnauthorizedHandler = (handler: (() => void) | null): void => {
  handleUnauthorizedRef.current = handler;
};

/** Usado pelos hooks de tela: retorna `true` se o erro foi um 401 tratado. */
export const consumeUnauthorized = (error: unknown): boolean => {
  const status = error instanceof ApiError ? error.status : -1;
  if (status !== 401) {
    return false;
  }
  handleUnauthorizedRef.current?.();
  return true;
};
