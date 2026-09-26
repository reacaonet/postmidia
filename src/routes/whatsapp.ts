import { Router } from 'express';
import { z } from 'zod';
import { appendAudit, insertTemplate, listTemplates, updateTemplateStatus } from '../store';
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
