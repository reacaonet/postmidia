import { Router } from 'express';
import { z } from 'zod';
import { isNetwork, isProviderSpecApplicable, NETWORK_SPECS } from '../domain/networks';
import { postizIntegrationSettings } from '../channels/postiz/client';
import { checkCredential } from '../channels/credential-check';
import { syncAccountProviderSpec } from '../channels/provider-specs';
import { decryptSecret, encryptSecret } from '../security/secret-box';
import { asyncHandler } from '../http/async-handler';
import {
  appendAudit,
  deleteAccount,
  getAccount,
  insertAccount,
  listAccounts,
  listJobs,
  toPublicAccount,
  updateAccount,
  updateAccountStatus,
} from '../store';
import { requireRole, requireTenant, type AuthenticatedRequest } from '../http/tenant';
import type { TenantRequest } from '../http/tenant';

const router = Router();

const createAccountSchema = z.object({
  network: z.string().refine(isNetwork, 'Rede desconhecida'),
  externalAccountId: z.string().min(1),
  displayName: z.string().min(1),
  secret: z.string().min(1),
  scopes: z.array(z.string()).default([]),
  tokenExpiresAt: z.string().datetime().nullable().default(null),
});

const statusSchema = z.object({
  status: z.enum(['pending', 'active', 'expired', 'revoked', 'error']),
});

/**
 * Normaliza o identificador externo da conta.
 *
 * O `@` do Telegram e o caso que morde: o operador digita `@Estetichat` porque e
 * assim que o username aparece no Telegram e no Chatwoot, e a busca pela conta
 * passa a usar `@@Estetichat`, que nao casa com nada. Como nao havia como
 * editar a conta, o erro ficava sem correcao. Aqui o `@` de leading e
 * normalizado para exatamente um.
 *
 * Para as outras redes o valor entra como esta, porque cada provedor tem seu
 * formato e adivinhar por conta seria pior do que preservar.
 */
const normalizeExternalAccountId = (network: string, value: string): string => {
  const trimmed = value.trim();
  if (network !== 'telegram') {
    return trimmed;
  }
  return `@${trimmed.replace(/^@+/, '')}`;
};

const updateAccountSchema = z
  .object({
    displayName: z.string().min(1).max(120).optional(),
    externalAccountId: z.string().min(1).max(200).optional(),
    secret: z.string().min(1).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'informe ao menos um campo para alterar',
  });

/**
 * Recusa o cadastro quando o provedor nao reconhece a credencial.
 *
 * O ganho nao e so recusar token furado: `identity.externalAccountId` volta
 * canonicalizado pelo provedor e substitui o que o operador digitou. Um URN de
 * LinkedIn montado a mao e um `@canal` com `@` a mais sao gravados na forma que
 * a API aceita, porque o provedor e a fonte da verdade, nao o texto da caixa.
 */
const assertCredential = async (
  network: string,
  secret: string,
  externalAccountId: string
): Promise<string> => {
  const check = await checkCredential(network as never, secret, externalAccountId);

  if (!check.ok) {
    throw Object.assign(new Error(check.error), {
      statusCode: 400,
      hint: check.hint,
    });
  }

  return check.identity.externalAccountId || externalAccountId;
};

router.get(
  '/accounts',
  requireTenant,
  asyncHandler(async (req, res) => {
    const tenantId = (req as TenantRequest).tenantId;
    res.json({ success: true, data: (await listAccounts(tenantId)).map(toPublicAccount) });
  })
);

router.post(
  '/accounts',
  requireTenant,
  requireRole('owner', 'admin'),
  asyncHandler(async (req, res) => {
    const request = req as AuthenticatedRequest;
    const input = createAccountSchema.parse(req.body);
    const normalized = normalizeExternalAccountId(input.network, input.externalAccountId);

    const externalAccountId = await assertCredential(input.network, input.secret, normalized);

    let account = await insertAccount({
      tenantId: request.tenantId,
      network: input.network,
      externalAccountId,
      displayName: input.displayName,
      encryptedSecret: encryptSecret(input.secret),
      // Token colado no painel nao tem de onde renovar: o provedor deu um token
      // de longa duracao. Quem renova e a conexao por OAuth.
      encryptedRefreshToken: null,
      scopes: input.scopes,
      status: 'active',
      tokenExpiresAt: input.tokenExpiresAt,
    });

    // Fase 7: ja no onboarding tentamos aprender os limites com o provedor. A
    // conta e criada mesmo se isso falhar, porque o sync degrada para o
    // NETWORK_SPECS em vez de derrubar o cadastro.
    const specs = await syncAccountProviderSpec(request.tenantId, account.id);
    if (specs.account) {
      account = specs.account;
    }

    await appendAudit({
      tenantId: request.tenantId,
      actorUserId: request.userId,
      actorEmail: request.email,
      action: 'account.created',
      entityType: 'channel_account',
      entityId: account.id,
      metadata: {
        network: account.network,
        displayName: account.displayName,
        providerMaxLength: account.providerMaxLength,
        specsSynced: specs.synced,
      },
    });

    if (specs.applicable && !specs.synced) {
      // 201 continua sendo onboarding bem-sucedido, mas o cliente precisa saber
      // que esta publicando com o limite fallback ate um re-sync funcionar.
      res.status(201).set('X-Provider-Specs', 'stale').json({ success: true, data: toPublicAccount(account) });
      return;
    }

    res.status(201).json({ success: true, data: toPublicAccount(account) });
  })
);

router.post(
  '/accounts/:id/sync-specs',
  requireTenant,
  requireRole('owner', 'admin'),
  asyncHandler(async (req, res) => {
    const request = req as AuthenticatedRequest;
    const result = await syncAccountProviderSpec(request.tenantId, req.params.id);

    if (!result.applicable) {
      res.status(422).json({
        success: false,
        error: `Rede ${result.account.network} e nativa e nao possui specs de provedor`,
      });
      return;
    }

    if (!result.synced) {
      res.status(502).json({
        success: false,
        error: 'Provedor indisponivel para ler specs; cache anterior preservado',
        detail: result.error,
        data: toPublicAccount(result.account),
      });
      return;
    }

    await appendAudit({
      tenantId: request.tenantId,
      actorUserId: request.userId,
      actorEmail: request.email,
      action: 'account.specs_synced',
      entityType: 'channel_account',
      entityId: result.account.id,
      metadata: {
        network: result.account.network,
        providerMaxLength: result.account.providerMaxLength,
      },
    });

    res.json({ success: true, data: toPublicAccount(result.account) });
  })
);

router.patch(
  '/accounts/:id',
  requireTenant,
  requireRole('owner', 'admin'),
  asyncHandler(async (req, res) => {
    const request = req as AuthenticatedRequest;
    const input = updateAccountSchema.parse(req.body);

    const previous = await getAccount(request.tenantId, req.params.id);
    if (!previous) {
      res.status(404).json({ success: false, error: 'Conta nao encontrada' });
      return;
    }

    // Trocar o segredo e trocar o destino sao a mesma decisao para o provedor:
    // um token novo com o chat antigo continua quebrado, e vice-versa. Por isso
    // o par que vai valer e validado junto, e nao campo por campo.
    let externalAccountId: string | undefined;
    if (input.secret !== undefined || input.externalAccountId !== undefined) {
      const candidate = normalizeExternalAccountId(
        previous.network,
        input.externalAccountId ?? previous.externalAccountId
      );
      externalAccountId = await assertCredential(
        previous.network,
        input.secret ?? decryptSecret(previous.encryptedSecret),
        candidate
      );
    }

    const updated = await updateAccount(request.tenantId, req.params.id, {
      displayName: input.displayName,
      externalAccountId,
      encryptedSecret: input.secret === undefined ? undefined : encryptSecret(input.secret),
      // Rede com bridge so aceita publicar de novo depois que o sync valida o
      // token novo, entao `pending` ate la. Rede nativa (telegram) nao tem sync:
      // marcar `pending` deixaria a conta bloqueada para sempre, ja que o
      // publish recusa status diferente de `active` e nada devolve a conta.
      status:
        input.secret === undefined
          ? undefined
          : isProviderSpecApplicable(previous.network)
            ? 'pending'
            : 'active',
    });

    if (!updated) {
      res.status(404).json({ success: false, error: 'Conta nao encontrada' });
      return;
    }

    await appendAudit({
      tenantId: request.tenantId,
      actorUserId: request.userId,
      actorEmail: request.email,
      action: 'account.updated',
      entityType: 'channel_account',
      entityId: updated.id,
      metadata: {
        network: updated.network,
        // O segredo novo NUNCA entra no audit: so o fato de que ele trocou.
        secretRotated: input.secret !== undefined,
        displayNameChanged: input.displayName !== undefined && input.displayName !== previous.displayName,
        externalAccountIdChanged:
          input.externalAccountId !== undefined &&
          normalizeExternalAccountId(previous.network, input.externalAccountId) !==
            previous.externalAccountId,
      },
    });

    res.json({ success: true, data: toPublicAccount(updated) });
  })
);

router.delete(
  '/accounts/:id',
  requireTenant,
  requireRole('owner', 'admin'),
  asyncHandler(async (req, res) => {
    const request = req as AuthenticatedRequest;
    const previous = await getAccount(request.tenantId, req.params.id);
    if (!previous) {
      res.status(404).json({ success: false, error: 'Conta nao encontrada' });
      return;
    }

    // Publicar e a unica forma de a conta virar lixo: se ha job pendente ou em
    // voo, apagar agora deixaria o worker sem destino para o resultado. O
    // operador espera a fila drainar ou cancela antes.
    const busy = await listJobs(request.tenantId);
    const inFlight = busy.some(
      (job) =>
        job.channelAccountId === req.params.id &&
        (job.status === 'queued' || job.status === 'running')
    );
    if (inFlight) {
      res.status(409).json({
        success: false,
        error: 'Conta tem publicacoes pendentes; aguarde a fila esvaziar antes de excluir',
      });
      return;
    }

    const deleted = await deleteAccount(request.tenantId, req.params.id);
    if (!deleted) {
      res.status(404).json({ success: false, error: 'Conta nao encontrada' });
      return;
    }

    await appendAudit({
      tenantId: request.tenantId,
      actorUserId: request.userId,
      actorEmail: request.email,
      action: 'account.deleted',
      entityType: 'channel_account',
      entityId: previous.id,
      metadata: {
        network: previous.network,
        externalAccountId: previous.externalAccountId,
        displayName: previous.displayName,
      },
    });

    res.json({ success: true, data: { id: previous.id, deleted: true } });
  })
);

router.patch(
  '/accounts/:id/status',
  requireTenant,
  requireRole('owner', 'admin'),
  asyncHandler(async (req, res) => {
    const request = req as AuthenticatedRequest;
    const input = statusSchema.parse(req.body);

    const previous = await getAccount(request.tenantId, req.params.id);
    const updated = await updateAccountStatus(request.tenantId, req.params.id, input.status);
    if (!updated) {
      res.status(404).json({ success: false, error: 'Conta nao encontrada' });
      return;
    }

    await appendAudit({
      tenantId: request.tenantId,
      actorUserId: request.userId,
      actorEmail: request.email,
      action: 'account.status_changed',
      entityType: 'channel_account',
      entityId: updated.id,
      metadata: { from: previous?.status ?? null, to: input.status, network: updated.network },
    });

    res.json({ success: true, data: toPublicAccount(updated) });
  })
);

router.get(
  '/accounts/:id/settings',
  requireTenant,
  asyncHandler(async (req, res) => {
    const tenantId = (req as TenantRequest).tenantId;
    const account = await getAccount(tenantId, req.params.id);

    if (!account) {
      res.status(404).json({ success: false, error: 'Conta nao encontrada' });
      return;
    }

    const cached = {
      maxLength: account.providerMaxLength,
      rules: account.providerRules,
      syncedAt: account.specsSyncedAt,
    };

    // Telegram e WhatsApp sao nativos: nao ha endpoint de specs no Postiz para
    // elas, e tentar chamar resultaria em 404 sempre.
    if (!isProviderSpecApplicable(account.network)) {
      res.json({
        success: true,
        data: {
          network: account.network,
          native: true,
          fallbackMaxLength: NETWORK_SPECS[account.network].text.maxChars,
          cached,
        },
      });
      return;
    }

    // O erro do provedor NAO pode escapar cru. O handler global usa
    // `error.status`, e um 401 do Postiz (token da conta invalido) viraria um
    // 401 da nossa API — que o painel leria como "sessao expirada" e expulsaria
    // o operador da tela, quando o problema e a conta dele, nao o login.
    // 502 + `detail` mantem a falha visivel sem mentir sobre quem recusou.
    let output: Record<string, unknown>;
    try {
      const result = await postizIntegrationSettings(
        decryptSecret(account.encryptedSecret),
        account.externalAccountId
      );
      output = result.output as unknown as Record<string, unknown>;
    } catch (error) {
      res.status(502).json({
        success: false,
        error: 'Provedor indisponivel para ler a configuracao da integracao',
        detail: error instanceof Error ? error.message : String(error),
        data: { network: account.network, native: false, cached },
      });
      return;
    }

    res.json({
      success: true,
      data: { network: account.network, native: false, cached, ...output },
    });
  })
);

export default router;
