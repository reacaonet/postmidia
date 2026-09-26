import { Router } from 'express';
import { z } from 'zod';
import { env } from '../config';
import { asyncHandler } from '../http/async-handler';
import { requireTenant, type AuthenticatedRequest } from '../http/tenant';
import { signToken } from '../security/jwt';
import { burnPasswordCheck, hashPassword, verifyPassword } from '../security/password';
import {
  appendAudit,
  createTenant,
  findUserByEmail,
  getTenantBySlug,
  findUserById,
  insertUser,
  listAudit,
  toPublicUser,
} from '../store';

const router = Router();

const slugSchema = z
  .string()
  .min(3)
  .max(63)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, 'slug deve conter apenas letras minusculas, digitos e hifen');

const emailSchema = z.string().email().max(254);

const passwordSchema = z
  .string()
  .min(10, 'senha deve ter ao menos 10 caracteres')
  .max(200)
  .refine((value) => /[a-zA-Z]/.test(value) && /[0-9]/.test(value), {
    message: 'senha deve combinar letras e numeros',
  });

const signupSchema = z.object({
  tenantName: z.string().min(2).max(120),
  slug: slugSchema,
  email: emailSchema,
  password: passwordSchema,
});

const loginSchema = z.object({
  slug: slugSchema,
  email: emailSchema,
  password: z.string().min(1).max(200),
});

router.post(
  '/auth/signup',
  asyncHandler(async (req, res) => {
    if (!env.ALLOW_SELF_SIGNUP) {
      res.status(403).json({
        success: false,
        error: 'Signup desabilitado; habilite ALLOW_SELF_SIGNUP ou provisione o tenant por migration',
      });
      return;
    }

    const input = signupSchema.parse(req.body);

    if (await getTenantBySlug(input.slug)) {
      res.status(409).json({ success: false, error: `slug "${input.slug}" ja esta em uso` });
      return;
    }

    const tenant = await createTenant({ name: input.tenantName, slug: input.slug });
    const user = await insertUser({
      tenantId: tenant.id,
      email: input.email,
      passwordHash: await hashPassword(input.password),
      role: 'owner',
    });

    await appendAudit({
      tenantId: tenant.id,
      actorUserId: user.id,
      actorEmail: user.email,
      action: 'tenant.created',
      entityType: 'tenant',
      entityId: tenant.id,
      metadata: { slug: tenant.slug },
    });

    res.status(201).json({
      success: true,
      data: {
        token: signToken({
          sub: user.id,
          tenantId: tenant.id,
          email: user.email,
          role: user.role,
        }),
        user: toPublicUser(user),
        tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug },
      },
    });
  })
);

router.post(
  '/auth/login',
  asyncHandler(async (req, res) => {
    const input = loginSchema.parse(req.body);

    // O login nao tem contexto de tenant ainda, por isso usa o slug.
    // Isso mantem a leitura de users dentro do RLS, sem um SELECT cross-tenant.
    const tenant = await getTenantBySlug(input.slug);
    const user = tenant ? await findUserByEmail(tenant.id, input.email) : undefined;

    if (!user || user.status !== 'active') {
      // Custo constante: nao revela se o e-mail existe pelo tempo de resposta.
      await burnPasswordCheck(input.password);
      res.status(401).json({ success: false, error: 'Credenciais invalidas' });
      return;
    }

    if (!(await verifyPassword(input.password, user.passwordHash))) {
      res.status(401).json({ success: false, error: 'Credenciais invalidas' });
      return;
    }

    await appendAudit({
      tenantId: tenant!.id,
      actorUserId: user.id,
      actorEmail: user.email,
      action: 'auth.login',
      entityType: 'user',
      entityId: user.id,
      metadata: {},
    });

    res.json({
      success: true,
      data: {
        token: signToken({
          sub: user.id,
          tenantId: tenant!.id,
          email: user.email,
          role: user.role,
        }),
        user: toPublicUser(user),
      },
    });
  })
);

router.get(
  '/auth/me',
  requireTenant,
  asyncHandler(async (req, res) => {
    const request = req as AuthenticatedRequest;
    const user = await findUserById(request.tenantId, request.userId);

    res.json({
      success: true,
      data: {
        user: user ? toPublicUser(user) : null,
        tenantId: request.tenantId,
        role: request.role,
      },
    });
  })
);

router.get(
  '/audit',
  requireTenant,
  asyncHandler(async (req, res) => {
    const request = req as AuthenticatedRequest;
    const limit = Math.min(Number(req.query.limit ?? 50) || 50, 500);
    res.json({ success: true, data: await listAudit(request.tenantId, limit) });
  })
);

export default router;
