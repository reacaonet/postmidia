import { providerHttp } from '../provider-http';
import { encryptSecret } from '../../security/secret-box';
import { checkCredential } from '../credential-check';
import { oauthProvider, type OAuthProviderConfig } from './config';

/**
 * Token guardado pela conexao.
 *
 * O refresh token e separado porque a rotina de renovar devolve um access token
 * NOVO sem tocar no refresh: e o access token que tem prazo curto (o LinkedIn
 * dá 60 dias para membro), e o refresh token que e o ativo de longo prazo.
 */
export type OAuthTokens = {
  accessToken: string;
  refreshToken: string | null;
  /** ISO do vencimento do access token, quando o provedor informa. */
  expiresAt: string | null;
  scopes: string[];
};

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  authorization_code?: string;
  error?: string;
  error_description?: string;
};

/**
 * Corpo do POST de token em `x-www-form-urlencoded`.
 *
 * Nao e JSON: o endpoint `/oauth/v2/accessToken` do LinkedIn le o corpo como
 * formulario e, com JSON, ele responde `A required parameter "grant_type" is
 * missing` -- mesmo com o campo enviado, porque nenhum parametro foi lido. O
 * `URLSearchParams` tambem cuida da percent-encode do `redirect_uri`, que traz
 * barras e dois pontos.
 */
const formBody = (fields: Record<string, string>): URLSearchParams => new URLSearchParams(fields);

export class OAuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly hint?: string
  ) {
    super(message);
    this.name = 'OAuthError';
  }
}

/**
 * Troca o codigo de autorizacao por tokens.
 *
 * O `client_secret` vai no corpo porque o LinkedIn exige client authentication
 * mesmo no fluxo com PKCE, e porque o `redirect_uri` tem que voltar identico ao
 * do passo anterior -- sem isso o provedor responde `invalid_grant` e o erro
 * chega no painel como "conexao recusada", sem pista do porque.
 */
export const exchangeCodeForTokens = async (
  provider: OAuthProviderConfig,
  code: string
): Promise<OAuthTokens> => {
  let data: TokenResponse;

  try {
    const response = await providerHttp.post<TokenResponse>(provider.tokenUrl, formBody({
      grant_type: 'authorization_code',
      code,
      client_id: provider.clientId,
      client_secret: provider.clientSecret,
      redirect_uri: provider.redirectUri,
    }));
    data = response.data;
  } catch (error) {
    const body = (error as { response?: { data?: TokenResponse } }).response?.data;
    throw new OAuthError(
      body?.error ?? 'token_request_failed',
      body?.error_description ??
        (error instanceof Error ? error.message : 'Falha ao trocar o codigo por token'),
      'Se o erro for invalid_grant, o codigo ja foi usado ou expirou. Tente conectar de novo.'
    );
  }

  if (data.error || !data.access_token) {
    throw new OAuthError(
      data.error ?? 'no_access_token',
      data.error_description ?? 'O provedor nao devolveu access token',
      'Cheque se o app tem o produto/escopo de publicacao habilitado e se o callback esta autorizado.'
    );
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresAt: data.expires_in
      ? new Date(Date.now() + data.expires_in * 1000).toISOString()
      : null,
    scopes: data.scope ? data.scope.split(/\s+/).filter(Boolean) : provider.scopes,
  };
};

/**
 * Renova o access token antes de publicar.
 *
 * Falhar aqui e sendo nao-recuperavel de proposito: repetir a mesma renovacao com
 * um refresh token invalido so gasta cota do LinkedIn e adia o alerta. O worker
 * marca a conta como `error`, que e o estado que diz ao operador "reconecte".
 */
export const refreshTokens = async (
  network: OAuthProviderConfig['network'],
  refreshToken: string
): Promise<OAuthTokens> => {
  const provider = oauthProvider(network);

  if (!provider) {
    throw new OAuthError('provider_not_configured', `${network} nao tem OAuth configurado`);
  }

  let data: TokenResponse;

  try {
    const response = await providerHttp.post<TokenResponse>(provider.tokenUrl, formBody({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: provider.clientId,
      client_secret: provider.clientSecret,
    }));
    data = response.data;
  } catch (error) {
    const body = (error as { response?: { data?: TokenResponse } }).response?.data;
    throw new OAuthError(
      body?.error ?? 'refresh_failed',
      body?.error_description ??
        (error instanceof Error ? error.message : 'Falha ao renovar o token'),
      'O refresh token foi revogado ou expirou. Conecte a conta de novo.'
    );
  }

  if (data.error || !data.access_token) {
    throw new OAuthError(
      data.error ?? 'refresh_failed',
      data.error_description ?? 'O provedor nao devolveu access token na renovacao',
      'O refresh token foi revogado ou expirou. Conecte a conta de novo.'
    );
  }

  return {
    accessToken: data.access_token,
    // O LinkedIn devolve o refresh token na renovacao; outros provedores omitem,
    // e nesse caso o antigo continua valido e precisa ser preservado.
    refreshToken: data.refresh_token ?? refreshToken,
    expiresAt: data.expires_in
      ? new Date(Date.now() + data.expires_in * 1000).toISOString()
      : null,
    scopes: data.scope ? data.scope.split(/\s+/).filter(Boolean) : provider.scopes,
  };
};

/**
 * Confirma o token recem-trocado antes de gravar a conta.
 *
 * Sem esta checagem, o callback cria a conta `active` mesmo quando o token
 * veio sem os escopos de escrita, e o operador so descobre na fila morta -- o
 * mesmo atraso que a validacao ao vivo do cadastro ja eliminou para o token
 * colado. A conexao por OAuth passa pelo mesmo padrao.
 */
export const assertTokensUsable = async (
  network: OAuthProviderConfig['network'],
  tokens: OAuthTokens
): Promise<{ externalAccountId: string; displayName: string }> => {
  const check = await checkCredential(network, tokens.accessToken, '');

  if (!check.ok) {
    throw new OAuthError('token_not_usable', check.error, check.hint);
  }

  if (!check.identity.externalAccountId) {
    throw new OAuthError(
      'identity_not_resolved',
      `O provedor aceitou o token de ${network} mas nao devolveu com quem ele publica`,
      'Verifique se o app tem as versoes de produto habilitadas e se o escopo de leitura de perfil foi concedido.'
    );
  }

  return {
    externalAccountId: check.identity.externalAccountId,
    displayName: check.identity.displayName,
  };
};

export const encryptTokens = (tokens: OAuthTokens): {
  encryptedSecret: string;
  encryptedRefreshToken: string | null;
} => ({
  encryptedSecret: encryptSecret(tokens.accessToken),
  encryptedRefreshToken: tokens.refreshToken ? encryptSecret(tokens.refreshToken) : null,
});
