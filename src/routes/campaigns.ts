import { Router } from 'express';
import { z } from 'zod';
import { enrichMedia } from '../channels/media-probe';
import { expandTargets, validatePostForTargets, type PostTarget } from '../channels/post-validation';
import type { PublishSpec } from '../channels/adapter';
import { decryptSecret } from '../security/secret-box';
import {
  getAccount,
  getCampaign,
  getJob,
  getPost,
  insertCampaign,
  insertJob,
  insertPost,
  listCampaigns,
  listJobs,
  listPosts,
  toPublicAccount,
  updateJobSchedule,
  updatePost,
} from '../store';
import type { ChannelAccount, PublishJobStatus, ResolvedChannelAccount } from '../domain/types';
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

const editPostSchema = z.object({
  contentType: z.string().min(1).optional(),
  text: z.string().optional(),
  media: z.array(mediaSchema).optional(),
  settings: z.record(z.unknown()).optional(),
});

const rescheduleSchema = z.object({
  scheduledAt: z.string().datetime(),
});

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

    const resolvedById = new Map<string, ResolvedChannelAccount>();
    for (const account of accounts.values()) {
      if (account === undefined) {
        continue;
      }
      resolvedById.set(account.id, {
        ...account,
        secret: decryptSecret(account.encryptedSecret),
      });
    }

    const targets = expandTargets(
      [...accounts.values()].filter(
        (account): account is NonNullable<typeof account> => account !== undefined
      ),
      resolvedById,
      input.audience
    );

    // O tamanho da midia e derivado do servidor quando o cliente nao manda.
    // Sem isto, `image_too_large`/`video_too_large` so disparavam para quem se
    // deu ao trabalho de declarar `bytes`, e o limite de 8 MB do Instagram nao
    // valia para ninguem. A sonda nunca lanca e nunca bloqueia o post: e
    // melhor-esforco, e a autoridade definitiva chega com o storage da Fase 8.
    const media = await enrichMedia(input.media);

    const spec: PublishSpec = {
      text: input.text,
      media,
      contentType: input.contentType,
      settings: input.settings,
      recipient: null,
      idempotencyKey: `draft-${Date.now()}`,
    };

    const rejections = await validatePostForTargets(spec, targets);

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
      media,
      settings: input.settings,
    });

    const delayMs = Math.max(0, new Date(scheduledAt).getTime() - Date.now());

    const jobs = [];
    for (const { account, recipient } of targets) {
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
  '/campaigns/:id/posts',
  requireTenant,
  asyncHandler(async (req, res) => {
    const tenantId = (req as TenantRequest).tenantId;

    const campaign = await getCampaign(tenantId, req.params.id);
    if (!campaign) {
      res.status(404).json({ success: false, error: 'Campanha nao encontrada' });
      return;
    }

    res.json({ success: true, data: await listPosts(tenantId, { campaignId: campaign.id }) });
  })
);

/**
 * Corrige o conteudo de um post que ainda nao foi publicado.
 *
 * O worker le o post do banco no momento da execucao, entao alterar o conteudo
 * vale para todos os jobs ainda na fila sem precisar reenfileirar nada.
 *
 * A guarda e o que torna isso seguro: enquanto nenhum job do post rodou, o
 * conteudo e um rascunho, e um rascunho pode ser corrigido. Depois que um job
 * rodou, o texto gravado em `sp_posts` virou o registro do que foi publicado e
 * sobrescreve-lo deixaria o historico sem relacao com o que saiu na rede.
 */
router.patch(
  '/posts/:id',
  requireTenant,
  asyncHandler(async (req, res) => {
    const request = req as AuthenticatedRequest;
    const input = editPostSchema.parse(req.body);
    const tenantId = request.tenantId;

    const post = await getPost(tenantId, req.params.id);
    if (!post) {
      res.status(404).json({ success: false, error: 'Post nao encontrado' });
      return;
    }

    const jobs = await listJobs(tenantId, { postId: post.id });
    const ran = jobs.filter((job) => job.status !== 'queued' && job.status !== 'cancelled');

    if (ran.length > 0) {
      res.status(409).json({
        success: false,
        error: 'Post ja publicado: conteudo de post com job executado nao pode ser alterado',
        data: { publishedJobs: ran.length, statuses: [...new Set(ran.map((job) => job.status))] },
      });
      return;
    }

    const media = input.media === undefined ? post.media : await enrichMedia(input.media);
    const text = input.text ?? post.text;
    const contentType = input.contentType ?? post.contentType;
    const settings = input.settings ?? post.settings;

    // Revalida contra os destinos ja gravados nos jobs, com o destinatario de
    // cada um. Reaproveitar os jobs em vez dos `accountIds` da criacao importa:
    // a audiencia de WhatsApp ja foi expandida em uma linha por contato, e e
    // essa lista que decide para quem o texto novo e valido.
    const resolvedById = new Map<string, ResolvedChannelAccount>();
    const accountsById = new Map<string, ChannelAccount>();
    for (const id of new Set(jobs.map((job) => job.channelAccountId))) {
      const account = await getAccount(tenantId, id);
      if (!account) {
        res.status(409).json({ success: false, error: `Conta de destino nao existe mais: ${id}` });
        return;
      }
      accountsById.set(id, account);
      resolvedById.set(id, { ...account, secret: decryptSecret(account.encryptedSecret) });
    }

    const targets: PostTarget[] = jobs.flatMap((job) => {
      const account = accountsById.get(job.channelAccountId);
      const resolved = resolvedById.get(job.channelAccountId);
      return account === undefined || resolved === undefined
        ? []
        : [{ account, resolved, recipient: job.recipient }];
    });

    const spec: PublishSpec = {
      text,
      media,
      contentType,
      settings,
      recipient: null,
      idempotencyKey: `edit-${post.id}-${Date.now()}`,
    };

    const rejections = await validatePostForTargets(spec, targets);
    if (rejections.length > 0) {
      res.status(422).json({
        success: false,
        error: 'Post invalido para um ou mais destinos',
        data: rejections,
      });
      return;
    }

    const updated = await updatePost(tenantId, post.id, { contentType, text, media, settings });
    if (!updated) {
      res.status(404).json({ success: false, error: 'Post nao encontrado' });
      return;
    }

    await appendAudit({
      tenantId,
      actorUserId: request.userId,
      actorEmail: request.email,
      action: 'post.updated',
      entityType: 'post',
      entityId: post.id,
      metadata: {
        campaignId: post.campaignId,
        fields: Object.keys(input),
        affectedJobs: jobs.length,
      },
    });

    res.json({ success: true, data: { post: updated } });
  })
);

/**
 * Move o horario de um job na fila.
 *
 * So `queued`: um job em execucao ja foi entregue ao provider, e um job
 * terminado nao tem o que reagendar.
 */
router.patch(
  '/jobs/:id/schedule',
  requireTenant,
  asyncHandler(async (req, res) => {
    const request = req as AuthenticatedRequest;
    const input = rescheduleSchema.parse(req.body);
    const tenantId = request.tenantId;

    const job = await getJob(tenantId, req.params.id);
    if (!job) {
      res.status(404).json({ success: false, error: 'Job nao encontrado' });
      return;
    }

    if (job.status !== 'queued') {
      res.status(409).json({
        success: false,
        error: `Job em ${job.status}; so job na fila pode ser reagendado`,
      });
      return;
    }

    const scheduledAt = new Date(input.scheduledAt).toISOString();
    const updated = await updateJobSchedule(tenantId, job.id, scheduledAt);
    if (!updated) {
      res.status(404).json({ success: false, error: 'Job nao encontrado' });
      return;
    }

    await queue.reschedule(updated, Math.max(0, new Date(scheduledAt).getTime() - Date.now()));

    await appendAudit({
      tenantId,
      actorUserId: request.userId,
      actorEmail: request.email,
      action: 'job.rescheduled',
      entityType: 'job',
      entityId: job.id,
      metadata: { from: job.scheduledAt, to: scheduledAt, network: job.network },
    });

    res.json({ success: true, data: { job: updated } });
  })
);

/**
 * Puxa um job da fila para agora.
 *
 * Reagendar para o instante corrente e o mesmo caminho do `PATCH
 * /jobs/:id/schedule`, o que mantem uma unica operacao de fila: remove a
 * entrada antiga e agenda a nova com o horario novo.
 */
router.post(
  '/jobs/:id/dispatch',
  requireTenant,
  asyncHandler(async (req, res) => {
    const request = req as AuthenticatedRequest;
    const tenantId = request.tenantId;

    const job = await getJob(tenantId, req.params.id);
    if (!job) {
      res.status(404).json({ success: false, error: 'Job nao encontrado' });
      return;
    }

    if (job.status !== 'queued') {
      res.status(409).json({
        success: false,
        error: `Job em ${job.status}; so job na fila pode ser enviado agora`,
      });
      return;
    }

    const scheduledAt = new Date().toISOString();
    const updated = await updateJobSchedule(tenantId, job.id, scheduledAt);
    if (!updated) {
      res.status(404).json({ success: false, error: 'Job nao encontrado' });
      return;
    }

    await queue.reschedule(updated, 0);

    await appendAudit({
      tenantId,
      actorUserId: request.userId,
      actorEmail: request.email,
      action: 'job.dispatch_now',
      entityType: 'job',
      entityId: job.id,
      metadata: { from: job.scheduledAt, to: scheduledAt, network: job.network },
    });

    res.json({ success: true, data: { job: updated } });
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
