import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import type { Network } from '../domain/networks';
import type { ChannelAccount } from '../domain/types';
import { isNetwork } from '../domain/networks';
import { appendAudit, insertAccount, listAccounts, updateAccount } from '../store';
import { asyncHandler } from '../http/async-handler';
import { requireRole, requireTenant, type AuthenticatedRequest } from '../http/tenant';
import { buildAuthorizeUrl, oauthProvider, signOAuthState, verifyOAuthState } from '../channels/oauth/config';
import {
  assertTokensUsable,
  encryptTokens,
  exchangeCodeForTokens,
  OAuthError,
} from '../channels/oauth/tokens';

const router = Router();

/** Redes que o painel oferece para conectar. */
export const CONNECTABLE_NETWORKS: readonly Network[] = ['linkedin'];

/**
 * Comeca a conexao: devolve a URL que o painel abre numa aba nova.
 *
 * A rota nao redireciona. Quem redireciona e o painel, porque o callback cai
 * no navegador e nao no fetch -- e porque o painel precisa mostrar "conectando"
 * enquanto o usuario esta na tela do LinkedIn. Devolver a URL tambem deixa o
 * teste de ponta a ponta possivel sem abrir navegador.
 */
router.get(
  '/oauth/:network/connect',
  requireTenant,
  requireRole('owner', 'admin'),
  asyncHandler(async (req, res) => {
    const request = req as AuthenticatedRequest;
    const network = req.params.network as Network;

    if (!isNetwork(network) || !CONNECTABLE_NETWORKS.includes(network)) {
      res.status(404).json({ success: false, error: `Rede sem conexao por OAuth: ${network}` });
      return;
    }

    const provider = oauthProvider(network);

    if (!provider) {
      res.status(503).json({
        success: false,
        error: `${network} ainda nao tem OAuth configurado neste ambiente`,
        hint:
          'Faltam as credenciais do app no ambiente da API (LINKEDIN_CLIENT_ID / LINKEDIN_CLIENT_SECRET) ' +
          'e a URL publica do produto (OAUTH_REDIRECT_BASE_URL). Sem elas nao existe para onde o ' +
          'provedor devolver o codigo.',
      });
      return;
    }

    const state = signOAuthState({
      tenantId: request.tenantId,
      network,
      actorUserId: request.userId,
      actorEmail: request.email,
      nonce: randomBytes(8).toString('hex'),
    });

    await appendAudit({
      tenantId: request.tenantId,
      actorUserId: request.userId,
      actorEmail: request.email,
      action: 'account.oauth_started',
      entityType: 'channel_account',
      entityId: network,
      metadata: { network },
    });

    res.json({
      success: true,
      data: { network, authorizeUrl: buildAuthorizeUrl(provider, state), redirectUri: provider.redirectUri },
    });
  })
);

/**
 * Recebe o codigo do provedor e cria a conta.
 *
 * Duas caracteristicas que nao sao detalhe:
 *
 * 1. **Rota publica.** O provedor abre no navegador do cliente, sem
 *    `Authorization`. A autenticacao aqui e o `state`, que e um JWT assinado
 *    carregando o tenant -- e o que impede um callback forjado de criar conta
 *    em um tenant alheio.
 *
 * 2. **Responde HTML, nao JSON.** A URL fica na barra de endereco do navegador,
 *    entao um JSON de erro viraria uma tela crua para o usuario final. O fluxo
 *    feliz tambem devolve HTML, por isso o painel nao depende de ler a resposta
 *    do callback: ele so recarrega a lista de contas.
 */
router.get(
  '/oauth/:network/callback',
  asyncHandler(async (req, res) => {
    const network = req.params.network as Network;
    const code = typeof req.query.code === 'string' ? req.query.code : null;
    const state = typeof req.query.state === 'string' ? req.query.state : null;
    const oauthError = typeof req.query.error === 'string' ? req.query.error : null;
    const oauthErrorDescription =
      typeof req.query.error_description === 'string' ? req.query.error_description : null;

    const fail = (status: number, title: string, detail: string): void => {
      res.status(status).type('html').send(page(title, detail));
    };

    if (oauthError) {
      fail(
        400,
        'A conexao foi recusada',
        `${oauthError}${oauthErrorDescription ? `: ${oauthErrorDescription}` : ''}`
      );
      return;
    }

    if (!code || !state) {
      fail(400, 'Callback incompleto', 'O provedor nao devolveu o codigo de autorizacao.');
      return;
    }

    const claims = verifyOAuthState(state);

    if (!claims) {
      fail(
        400,
        'Sessao de conexao expirada',
        'O link de conectar vale 10 minutos. Volte ao painel e clique em Conectar de novo.'
      );
      return;
    }

    if (claims.network !== network) {
      fail(400, 'Callback inconsistente', `O state e de ${claims.network}, e o callback e de ${network}.`);
      return;
    }

    const provider = oauthProvider(network);

    if (!provider) {
      fail(503, 'OAuth nao configurado', `As credenciais de ${network} sumiram do ambiente.`);
      return;
    }

    let identity: { externalAccountId: string; displayName: string };
    let tokens: ReturnType<typeof encryptTokens> & { expiresAt: string | null; scopes: string[] };

    try {
      const exchanged = await exchangeCodeForTokens(provider, code);
      identity = await assertTokensUsable(network, exchanged);
      tokens = { ...encryptTokens(exchanged), expiresAt: exchanged.expiresAt, scopes: exchanged.scopes };
    } catch (error) {
      const known = error instanceof OAuthError ? error : null;
      await appendAudit({
        tenantId: claims.tenantId,
        actorUserId: claims.actorUserId,
        actorEmail: claims.actorEmail,
        action: 'account.oauth_failed',
        entityType: 'channel_account',
        entityId: network,
        metadata: { network, code: known?.code ?? 'unknown' },
      });
      fail(
        400,
        'Nao deu para concluir a conexao',
        `${known?.message ?? 'Falha ao trocar o codigo por token'}${known?.hint ? `\n\n${known.hint}` : ''}`
      );
      return;
    }

    // Reconectar a mesma identidade tem que atualizar a conta existente, e nao
    // esbarrar no unique (tenant, network, external_account_id) nem criar uma
    // duplicata: o operador que reconecta esta corrigindo o acesso, nao criando
    // uma segunda conta para a mesma pessoa.
    const existing = await findByExternalId(claims.tenantId, network, identity.externalAccountId);

    const account = existing
      ? await updateAccount(claims.tenantId, existing.id, {
          encryptedSecret: tokens.encryptedSecret,
          encryptedRefreshToken: tokens.encryptedRefreshToken ?? undefined,
          tokenExpiresAt: tokens.expiresAt,
          displayName: identity.displayName,
          status: 'active',
        })
      : await insertAccount({
          tenantId: claims.tenantId,
          network,
          externalAccountId: identity.externalAccountId,
          displayName: identity.displayName,
          encryptedSecret: tokens.encryptedSecret,
          encryptedRefreshToken: tokens.encryptedRefreshToken,
          scopes: tokens.scopes,
          status: 'active',
          tokenExpiresAt: tokens.expiresAt,
        });

    if (!account) {
      fail(500, 'Falha ao salvar', 'A conexao funcionou, mas a conta nao pode ser gravada.');
      return;
    }

    await appendAudit({
      tenantId: claims.tenantId,
      actorUserId: claims.actorUserId,
      actorEmail: claims.actorEmail,
      action: existing ? 'account.oauth_reconnected' : 'account.oauth_connected',
      entityType: 'channel_account',
      entityId: account.id,
      metadata: {
        network,
        displayName: account.displayName,
        externalAccountId: account.externalAccountId,
        scopes: tokens.scopes,
      },
    });

    res.type('html').send(success(identity.displayName, network));
  })
);

const findByExternalId = async (
  tenantId: string,
  network: Network,
  externalAccountId: string
): Promise<ChannelAccount | undefined> => {
  const accounts = await listAccounts(tenantId);
  return accounts.find(
    (account) => account.network === network && account.externalAccountId === externalAccountId
  );
};

/**
 * Pagina do callback.
 *
 * Fica no servidor, e nao no painel, porque o callback e aberto como
 * navegacao (o provedor manda o browser para ca). Aqui nao ha SPA para montar;
 * o que o operador precisa e ver o resultado e voltar ao painel.
 */
const shell = (title: string, body: string): string => `<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
  </head>
  <body style="font-family: system-ui, sans-serif; background:#0f172a; color:#e2e8f0; display:grid; place-items:center; min-height:100vh; margin:0">
    <main style="max-width:34rem; padding:2rem; text-align:center">
      ${body}
    </main>
  </body>
</html>`;

const escape = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

const success = (displayName: string, network: Network): string =>
  shell(
    'Conta conectada',
    `<h1 style="font-size:1.4rem">Conta conectada</h1>
     <p style="color:#94a3b8">${escape(displayName)} ja pode receber campanhas.</p>
     <p style="color:#94a3b8">Esta aba pode ser fechada.</p>`
  );

const page = (title: string, detail: string): string =>
  shell(
    title,
    `<h1 style="font-size:1.4rem">${escape(title)}</h1>
     <p style="color:#94a3b8; white-space:pre-line">${escape(detail)}</p>
     <p style="color:#94a3b8">Volte ao painel e tente de novo.</p>`
  );

export default router;
