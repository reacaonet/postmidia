import { Router } from 'express';
import { z } from 'zod';
import {
  appendAudit,
  findTemplate,
  insertTemplate,
  listTemplates,
  updateTemplateStatus,
} from '../store';
import { explainTemplateTransition } from '../channels/whatsapp/template-status';
import { requireRole, requireTenant, type AuthenticatedRequest } from '../http/tenant';
import { asyncHandler } from '../http/async-handler';

const router = Router();

const createTemplateSchema = z.object({
  name: z.string().min(1),
  languageCode: z.string().min(2).default('pt_BR'),
  category: z.enum(['MARKETING', 'UTILITY', 'AUTHENTICATION']).default('MARKETING'),
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'PAUSED', 'DISABLED']).default('PENDING'),
  headerType: z.enum(['NONE', 'TEXT', 'IMAGE', 'VIDEO', 'DOCUMENT']).default('NONE'),
  variableCount: z.number().int().min(0).default(0),
});

const statusSchema = z.object({
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'PAUSED', 'DISABLED']),
});

router.get(
  '/whatsapp/templates',
  requireTenant,
  asyncHandler(async (req, res) => {
    const request = req as AuthenticatedRequest;
    const tenantId = request.tenantId;
    res.json({ success: true, data: await listTemplates(tenantId) });
  })
);

router.post(
  '/whatsapp/templates',
  requireTenant,
  requireRole('owner', 'admin'),
  asyncHandler(async (req, res) => {
    const request = req as AuthenticatedRequest;
    const input = createTemplateSchema.parse(req.body);

    // Sem esta checagem, o `UNIQUE (tenant_id, name, language_code)` estourava e
    // o handler generico devolvia 400 "violation of unique constraint" — que nao
    // diz qual template, nem o que fazer. A identidade do template inclui o
    // idioma: `promo` em pt_BR e `promo` em en_US sao templates distintos.
    const existing = await findTemplate(request.tenantId, input.name, input.languageCode);
    if (existing) {
      res.status(409).json({
        success: false,
        error: `Template "${input.name}" (${input.languageCode}) ja existe neste tenant (status ${existing.status})`,
      });
      return;
    }

    const created = await insertTemplate({ tenantId: request.tenantId, ...input });

    await appendAudit({
      tenantId: request.tenantId,
      actorUserId: request.userId,
      actorEmail: request.email,
      action: 'whatsapp_template.created',
      entityType: 'whatsapp_template',
      entityId: created.id,
      metadata: { name: created.name, status: created.status, variableCount: created.variableCount },
    });

    res.status(201).json({ success: true, data: created });
  })
);

router.patch(
  '/whatsapp/templates/:id/status',
  requireTenant,
  requireRole('owner', 'admin'),
  asyncHandler(async (req, res) => {
    const request = req as AuthenticatedRequest;
    const input = statusSchema.parse(req.body);

    const previous = (await listTemplates(request.tenantId)).find(
      (template) => template.id === req.params.id
    );
    if (!previous) {
      res.status(404).json({ success: false, error: 'Template nao encontrado' });
      return;
    }

    // A transicao e conferida antes de gravar. Sem isto, o PATCH aceitava
    // qualquer par do enum e o caminho REJECTED -> APPROVED na mao produzia um
    // template que a API aceitava e a Meta recusaria no envio.
    const refusal = explainTemplateTransition(previous.status, input.status);
    if (refusal) {
      res.status(409).json({ success: false, error: refusal });
      return;
    }

    const updated = await updateTemplateStatus(request.tenantId, req.params.id, input.status);
    if (!updated) {
      res.status(404).json({ success: false, error: 'Template nao encontrado' });
      return;
    }

    await appendAudit({
      tenantId: request.tenantId,
      actorUserId: request.userId,
      actorEmail: request.email,
      action: 'whatsapp_template.status_changed',
      entityType: 'whatsapp_template',
      entityId: updated.id,
      metadata: { name: updated.name, from: previous?.status ?? null, to: input.status },
    });

    res.json({ success: true, data: updated });
  })
);

export default router;
