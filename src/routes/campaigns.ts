import { Router } from 'express';
import { z } from 'zod';
import { hasAdapter, resolveAdapter } from '../channels/registry';
import type { PublishSpec } from '../channels/adapter';
import { decryptSecret } from '../security/secret-box';
import {
  getAccount,
  getCampaign,
  getJob,
  insertCampaign,
  insertJob,
  insertPost,
  listCampaigns,
  listJobs,
  toPublicAccount,
} from '../store';
import type { PublishJobStatus, ResolvedChannelAccount } from '../domain/types';
import { requireRole, requireTenant, type AuthenticatedRequest, type TenantRequest } from '../http/tenant';
import { asyncHandler } from '../http/async-handler';
import { appendAudit } from '../store';
import { reconcileJob } from '../reconcile';
import { queue } from '../worker';

const router = Router();

const mediaSchema = z.object({
  kind: z.enum(['image', 'video']),
  url: z.string().url(),
  bytes: z.number().int().positive().optional(),
  durationSeconds: z.number().int().positive().optional(),
  mimeType: z.string().optional(),
  width: z.number().int().optional(),
  height: z.number().int().optional(),
});

const createCampaignSchema = z.object({
  name: z.string().min(1),
});

const createPostSchema = z.object({
  contentType: z.string().min(1),
  text: z.string().default(''),
  media: z.array(mediaSchema).default([]),
  settings: z.record(z.unknown()).default({}),
  accountIds: z.array(z.string().min(1)).min(1),
  audience: z.array(z.string().min(1)).default([]),
  scheduledAt: z.string().datetime().optional(),
});

const EXPAND_AUDIENCE: Partial<Record<string, true>> = { whatsapp: true };

router.post(
  '/campaigns',
  requireTenant,
  asyncHandler(async (req, res) => {
    const tenantId = (req as TenantRequest).tenantId;
    const input = createCampaignSchema.parse(req.body);
    res.status(201).json({
      success: true,
      data: await insertCampaign({ tenantId, name: input.name, status: 'draft' }),
    });
  })
);

router.get(
  '/campaigns',
  requireTenant,
  asyncHandler(async (req, res) => {
    const tenantId = (req as TenantRequest).tenantId;
    res.json({ success: true, data: await listCampaigns(tenantId) });
  })
);

router.post(
  '/campaigns/:id/posts',
  requireTenant,
  asyncHandler(async (req, res) => {
    const request = req as AuthenticatedRequest;
    const input = createPostSchema.parse(req.body);
    const tenantId = request.tenantId;

    const campaign = await getCampaign(tenantId, req.params.id);
    if (!campaign) {
      res.status(404).json({ success: false, error: 'Campanha nao encontrada' });
      return;
    }

    const accounts = new Map<string, Awaited<ReturnType<typeof getAccount>>>();
    for (const id of input.accountIds) {
      accounts.set(id, await getAccount(tenantId, id));
    }

    const missing = input.accountIds.filter((id) => !accounts.get(id));
    if (missing.length > 0) {
      res.status(404).json({ success: false, error: `Contas nao encontradas: ${missing.join(', ')}` });
      return;
    }

    const targets = input.accountIds.map((id) => {
      const account = accounts.get(id)!;
      const resolved: ResolvedChannelAccount = {
        ...account,
        secret: decryptSecret(account.encryptedSecret),
      };
      return { account, resolved };
    });

    const spec: PublishSpec = {
      text: input.text,
      media: input.media,
      contentType: input.contentType,
      settings: input.settings,
      recipient: null,
      idempotencyKey: `draft-${Date.now()}`,
    };

    const rejections = (
      await Promise.all(
        targets.map(async ({ account, resolved }) => {
          if (!hasAdapter(account.network)) {
            return {
              accountId: account.id,
              network: account.network,
              issues: [
                {
                  field: 'account' as const,
                  code: 'no_adapter',
                  message: `Nenhum adapter registrado para ${account.network}`,
                },
              ],
            };
          }

          const baseSpec: PublishSpec = { ...spec, recipient: null };
          const needsAudience = EXPAND_AUDIENCE[account.network] === true;
          const candidates = needsAudience
            ? input.audience.length > 0
              ? input.audience
              : [null]
            : [null];

          const issues = (
            await Promise.all(
              candidates.map((recipient) =>
                resolveAdapter(account.network).validate({ ...baseSpec, recipient }, resolved)
              )
            )
          ).flat();

          return issues.length > 0 ? { accountId: account.id, network: account.network, issues } : null;
        })
      )
    ).filter((entry): entry is NonNullable<typeof entry> => entry !== null);

    if (rejections.length > 0) {
      res.status(422).json({
        success: false,
        error: 'Post invalido para um ou mais destinos',
        data: rejections,
      });
      return;
    }

    const scheduledAt = input.scheduledAt
      ? new Date(input.scheduledAt).toISOString()
      : new Date().toISOString();

    const post = await insertPost({
      tenantId,
      campaignId: campaign.id,
      contentType: input.contentType,
      text: input.text,
      media: input.media,
      settings: input.settings,
    });

    const delayMs = Math.max(0, new Date(scheduledAt).getTime() - Date.now());

    const jobs = [];
    for (const { account } of targets) {
      const needsAudience = EXPAND_AUDIENCE[account.network] === true;
      const recipients = needsAudience && input.audience.length > 0 ? input.audience : [null];

      for (const recipient of recipients) {
        jobs.push(
          await insertJob({
            tenantId,
            postId: post.id,
            channelAccountId: account.id,
            network: account.network,
            recipient,
            status: 'queued',
            scheduledAt,
            attempts: 0,
            externalPostId: null,
            permalink: null,
            lastError: null,
          })
        );
      }
    }

    for (const job of jobs) {
      await queue.enqueue(job, delayMs);
    }

    await appendAudit({
      tenantId,
      actorUserId: request.userId,
      actorEmail: request.email,
      action: 'post.dispatched',
      entityType: 'post',
      entityId: post.id,
      metadata: {
        campaignId: campaign.id,
        jobCount: jobs.length,
        networks: [...new Set(jobs.map((job) => job.network))],
        scheduledAt,
      },
    });

    res.status(201).json({
      success: true,
      data: {
        post,
        scheduledAt,
        jobs: jobs.map((job) => ({
          ...job,
          account: toPublicAccount(accounts.get(job.channelAccountId)!),
        })),
      },
    });
  })
);

router.get(
  '/jobs',
  requireTenant,
  asyncHandler(async (req, res) => {
    const tenantId = (req as TenantRequest).tenantId;
    const status = req.query.status as PublishJobStatus | undefined;
    const campaignId = req.query.campaignId as string | undefined;

    res.json({
      success: true,
      data: await listJobs(tenantId, {
        status: status ?? undefined,
        campaignId: campaignId ?? undefined,
      }),
    });
  })
);

/**
 * Forca a reconciliacao de um job publicado sem id do provedor.
 *
 * A varredura periodica (RECONCILE_ENABLED) cuida do caso comum. Esta rota
 * existe para quando o operador ja sabe qual post e nao quer esperar o
 * intervalo, e para reconciliar um job que a varredura idade ja desistiu de
 * consultar.
 */
router.post(
  '/jobs/:id/reconcile',
  requireTenant,
  // Le o segredo da conta e chama o Postiz em nome dela: e o mesmo nivel de
  // acesso da fila morta, nao uma leitura comum de job.
  requireRole('owner', 'admin'),
  asyncHandler(async (req, res) => {
    const tenantId = (req as TenantRequest).tenantId;
    const job = await getJob(tenantId, req.params.id);

    if (!job) {
      res.status(404).json({ success: false, error: 'Job nao encontrado' });
      return;
    }

    if (job.status !== 'succeeded') {
      res.status(409).json({
        success: false,
        error: `Job em ${job.status}; so job publicado tem id do provedor a reconciliar`,
      });
      return;
    }

    if (!job.releaseIdMissing) {
      res.status(409).json({
        success: false,
        error: 'Job ja tem o id do provedor, ou nao é reconciliável',
        data: { externalPostId: job.externalPostId, permalink: job.permalink },
      });
      return;
    }

    const outcome = await reconcileJob(job);

    if (outcome === 'skipped') {
      res.status(409).json({ success: false, error: 'Job sem id interno do Postiz para consultar' });
      return;
    }

    const updated = await getJob(tenantId, job.id);

    // `pending` e um resultado legitimo, nao um erro: o Postiz ainda nao tem o
    // id porque o provedor nao processou. 202 diz "aceito, ainda nao ha id".
    if (outcome === 'pending') {
      res.status(202).json({
        success: true,
        data: { outcome, externalPostId: updated?.externalPostId ?? null, permalink: updated?.permalink ?? null },
      });
      return;
    }

    if (outcome === 'error') {
      res.status(502).json({ success: false, error: 'Falha ao consultar o Postiz' });
      return;
    }

    res.json({
      success: true,
      data: { outcome, externalPostId: updated?.externalPostId ?? null, permalink: updated?.permalink ?? null },
    });
  })
);

export default router;
