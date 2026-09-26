import { Router } from 'express';
import { z } from 'zod';
import { isNetwork, isProviderSpecApplicable, NETWORK_SPECS } from '../domain/networks';
import { postizIntegrationSettings } from '../channels/postiz/client';
import { syncAccountProviderSpec } from '../channels/provider-specs';
import { decryptSecret, encryptSecret } from '../security/secret-box';
import { asyncHandler } from '../http/async-handler';
import { appendAudit, getAccount, insertAccount, listAccounts, toPublicAccount, updateAccountStatus } from '../store';
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

    let account = await insertAccount({
      tenantId: request.tenantId,
      network: input.network,
      externalAccountId: input.externalAccountId,
      displayName: input.displayName,
      encryptedSecret: encryptSecret(input.secret),
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

    const { output } = await postizIntegrationSettings(
      decryptSecret(account.encryptedSecret),
      account.externalAccountId
    );

    res.json({
      success: true,
      data: { network: account.network, native: false, cached, ...output },
    });
  })
);

export default router;
