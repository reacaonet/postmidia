import jwt, { type SignOptions } from 'jsonwebtoken';
import { env } from '../../config';
import type { Network } from '../../domain/networks';

/**
 * Configuracao OAuth por rede, lida do ambiente.
 *
 * A chave e por rede em vez de um bloco generico porque cada provedor escolhe os
 * nomes: o LinkedIn fala `client_id`, o Instagram (via Facebook Login) fala o
 * mesmo mas em outra URL, e o TikTok tem endpoints proprios. Um unico par
 * `OAUTH_CLIENT_ID` nao descreveria nenhuma das diferencas -- e a diferenca de
 * endpoint e justamente o que quebra o login quando se troca de rede.
 */
export type OAuthProviderConfig = {
  network: Network;
  clientId: string;
  clientSecret: string;
  /** Base publica da API deste produto, ex.: `https://app.exemplo.com`. */
  redirectUri: string;
  scopes: string[];
  authorizeUrl: string;
  tokenUrl: string;
};

const first = (...values: (string | undefined)[]): string => values.find((v) => !!v?.trim()) ?? '';

const redirectBase = (): string => first(env.OAUTH_REDIRECT_BASE_URL);

const callbackUri = (network: Network): string => `${redirectBase()}/api/oauth/${network}/callback`;

/**
 * Redes com OAuth disponivel hoje.
 *
 * `scopes` e o que a rede exige para postar, nao o maximo que o app aceita: um
 * escopo a mais faz o usuario ver uma tela de permissao maior do que o
 * necessario, e no LinkedIn isso derruba a aprovacao do app.
 */
const PROVIDERS: Partial<Record<Network, Omit<OAuthProviderConfig, 'network' | 'redirectUri'>>> = {
  linkedin: {
    clientId: first(env.LINKEDIN_CLIENT_ID),
    clientSecret: first(env.LINKEDIN_CLIENT_SECRET),
    scopes: ['openid', 'profile', 'email', 'w_member_social'],
    authorizeUrl: 'https://www.linkedin.com/oauth/v2/authorization',
    tokenUrl: 'https://www.linkedin.com/oauth/v2/accessToken',
  },
};

export const oauthProvider = (network: Network): OAuthProviderConfig | null => {
  const provider = PROVIDERS[network];

  if (!provider) {
    return null;
  }

  const redirectUri = callbackUri(network);

  // Sem base publica nao ha como montar o callback, e a URL relativa seria
  // recusada pelo provedor. Falhar aqui transformaria o erro em "invalid
  // redirect_uri" na tela do LinkedIn, que nao aponta a causa.
  if (!provider.clientId || !provider.clientSecret || !redirectBase()) {
    return null;
  }

  return { network, redirectUri, ...provider };
};

/**
 * `state` que carrega a conclusao da conexao sem guardar sessao no servidor.
 *
 * O provedor devolve o callback cru, sem cabecalhos: o `state` e o unico elo
 * entre o clique no painel e a conta que vai ser criada. Ele e um JWT curto,
 * assinado com o mesmo segredo do login, e carrega o tenant e o autor -- sem
 * isso, um callbackforjado criaria conta em qualquer tenant.
 *
 * O prazo e curto de proposito: entre o clique e o callback o usuario esta
 * logando no provedor, o que pode levar um minuto. Nao ha ganho em deixar a
 * janela maior, e uma janela maior e uma janela maior para replay.
 */
export type OAuthStateClaims = {
  tenantId: string;
  network: Network;
  actorUserId: string;
  actorEmail: string;
  /** Impede que dois painéis em paralelo troquem a conta entre si. */
  nonce: string;
};

const STATE_TTL_SECONDS = 600;

const STATE_OPTIONS: SignOptions = {
  algorithm: 'HS256',
  expiresIn: STATE_TTL_SECONDS,
  issuer: 'postmidia:oauth',
};

export const signOAuthState = (claims: OAuthStateClaims): string =>
  jwt.sign(claims, env.JWT_SECRET, STATE_OPTIONS);

export const verifyOAuthState = (state: string): OAuthStateClaims | null => {
  try {
    const decoded = jwt.verify(state, env.JWT_SECRET, {
      algorithms: ['HS256'],
      issuer: 'postmidia:oauth',
      maxAge: STATE_TTL_SECONDS,
    });

    if (typeof decoded === 'string') {
      return null;
    }

    const { tenantId, network, actorUserId, actorEmail, nonce } = decoded as Partial<OAuthStateClaims>;

    if (!tenantId || !network || !actorUserId || !actorEmail || !nonce) {
      return null;
    }

    return { tenantId, network, actorUserId, actorEmail, nonce };
  } catch {
    return null;
  }
};

/** URL que o painel abre numa aba nova. */
export const buildAuthorizeUrl = (provider: OAuthProviderConfig, state: string): string => {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: provider.clientId,
    redirect_uri: provider.redirectUri,
    state,
  });

  if (provider.scopes.length > 0) {
    params.set('scope', provider.scopes.join(' '));
  }

  return `${provider.authorizeUrl}?${params.toString()}`;
};
