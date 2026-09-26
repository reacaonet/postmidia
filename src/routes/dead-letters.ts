import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../http/async-handler';
import { requireRole, requireTenant, type AuthenticatedRequest } from '../http/tenant';
import type { TenantRequest } from '../http/tenant';
import { queue } from '../queue';
import { appendAudit, getDeadLetter, getJob, listDeadLetters, patchJob, resolveDeadLetter } from '../store';
import type { DeadLetterResolution } from '../domain/types';

const router = Router();

// Filtro de /dead-letters. `open` e um atalho para as entradas ainda nao
// tratadas, que e a triagem do dia a dia; o enum puro filtra por resolucao.
const listSchema = z.object({
  resolution: z.enum(['open', 'requeued', 'discarded']).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

const resolveSchema = z.object({
  action: z.enum(['requeue', 'discard']),
});

router.get(
  '/dead-letters',
  requireTenant,
  asyncHandler(async (req, res) => {
    const tenantId = (req as TenantRequest).tenantId;
    const filter = listSchema.parse(req.query);
    res.json({ success: true, data: await listDeadLetters(tenantId, filter) });
  })
);

router.post(
  '/dead-letters/:id/resolve',
  requireTenant,
  // Requeue dispara publicacao real em massa, entao fica no mesmo nivel das
  // demais mutacoes operacionais (contas, WhatsApp), que exigem owner/admin.
  requireRole('owner', 'admin'),
  asyncHandler(async (req, res) => {
    const request = req as AuthenticatedRequest;
    const { action } = resolveSchema.parse(req.body);

    const entry = await getDeadLetter(request.tenantId, req.params.id);
    if (!entry) {
      res.status(404).json({ success: false, error: 'Entrada de fila morta nao encontrada' });
      return;
    }

    if (entry.resolution) {
      res.status(409).json({
        success: false,
        error: `Entrada ja tratada como ${entry.resolution}`,
        data: entry,
      });
      return;
    }

    if (action === 'discard') {
      const resolved = await resolveDeadLetter(request.tenantId, entry.id, 'discarded');
      await auditResolution(request, entry.id, 'discarded', 0);
      res.json({ success: true, data: resolved });
      return;
    }

    const job = await getJob(request.tenantId, entry.jobId);
    if (!job) {
      res.status(409).json({
        success: false,
        error: 'O job desta entrada nao existe mais; marque como discard em vez de requeue',
      });
      return;
    }

    if (job.status === 'succeeded') {
      // Nao dead-letteramos sucesso, mas um requeue anterior pode ter
      // concluido entre a leitura e agora. Reagendar aqui republicaria.
      res.status(409).json({
        success: false,
        error: 'O job ja foi publicado; requeue republicaria o post',
        data: { jobStatus: job.status },
      });
      return;
    }

    // Orcamento de tentativas novo. Sem zerar, o job voltaria para a fila morta
    // na proxima falha sem dar chance a mais nenhuma.
    const requeued = await patchJob(request.tenantId, entry.jobId, {
      status: 'queued',
      attempts: 0,
      lastError: null,
    });

    const resolved = await resolveDeadLetter(request.tenantId, entry.id, 'requeued');

    // Token unico por requeue: zerar `attempts` faria a entrada receber o id
    // `#0` do dispatch original, que ainda existe em `completed`, e o BullMQ
    // ignoraria o `add` -- o requeue passaria como sucesso sem rodar.
    await queue.enqueue(
      { ...job, status: 'queued', attempts: 0 },
      0,
      `dlq-${entry.id}-${(resolved?.requeueCount ?? 1)}`
    );

    await auditResolution(request, entry.id, 'requeued', resolved?.requeueCount ?? 1);
    res.json({ success: true, data: { deadLetter: resolved, job: requeued } });
  })
);

const auditResolution = async (
  request: AuthenticatedRequest,
  entryId: string,
  resolution: DeadLetterResolution,
  requeueCount: number
): Promise<void> => {
  await appendAudit({
    tenantId: request.tenantId,
    actorUserId: request.userId,
    actorEmail: request.email,
    action: `dead_letter.${resolution}`,
    entityType: 'dead_letter_job',
    entityId: entryId,
    metadata: { resolution, requeueCount },
  }).catch((error: unknown) => {
    console.error(`[dead-letter] falha ao auditar ${resolution} de ${entryId}:`, error);
  });
};

export default router;
