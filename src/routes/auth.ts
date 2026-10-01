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
  findUserById,
  findUsersByEmail,
  getTenant,
  getTenantBySlug,
  insertUser,
  listAudit,
  toPublicUser,
} from '../store';
import type { User } from '../domain/types';

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
  /**
   * Opcional, e aceito so por compatibilidade: o painel pede so e-mail e senha.
   * Quando vem, ele estreita a busca e evita o varrimento cross-tenant.
   */
  slug: slugSchema.optional(),
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

    /*
     * Sem slug, o e-mail pode existir em varias empresas: `UNIQUE (tenant_id,
     * email)` permite. A senha e conferida contra TODOS os candidatos e o
     * acesso concede exatamente um tenant — o que casou. Sem o slug, escolher
     * "o primeiro" seria abrir uma porta para a empresa errada.
     */
    const candidates = input.slug
      ? await (async () => {
          const tenant = await getTenantBySlug(input.slug!);
          if (!tenant) return [];
          const user = await findUserByEmail(tenant.id, input.email);
          return user ? [user] : [];
        })()
      : (await findUsersByEmail(input.email)).filter((user) => user.status === 'active');

    const matches: User[] = [];
    for (const user of candidates) {
      if (await verifyPassword(input.password, user.passwordHash)) {
        matches.push(user);
      }
    }

    if (matches.length === 0) {
      // Custo constante: nao revela se o e-mail existe pelo tempo de resposta.
      await burnPasswordCheck(input.password);
      res.status(401).json({ success: false, error: 'Credenciais invalidas' });
      return;
    }

    if (matches.length > 1) {
      // Mesma senha em duas empresas com o mesmo e-mail: nao ha como saber qual
      // a pessoa quis. O slug desambigua; o erro diz isso em vez de chutar.
      res.status(409).json({
        success: false,
        error: 'Este e-mail existe em mais de uma empresa; informe o slug da empresa no login',
      });
      return;
    }

    const user = matches[0];
    const tenant = await getTenant(user.tenantId);

    await appendAudit({
      tenantId: user.tenantId,
      actorUserId: user.id,
      actorEmail: user.email,
      action: 'auth.login',
      entityType: 'user',
      entityId: user.id,
      metadata: input.slug ? { slug: input.slug } : {},
    });

    res.json({
      success: true,
      data: {
        token: signToken({
          sub: user.id,
          tenantId: user.tenantId,
          email: user.email,
          role: user.role,
        }),
        user: toPublicUser(user),
        // Sem o slug no pedido, o painel nao tem como saber o nome da empresa
        // por conta propria; devolver aqui evita um segundo round-trip so para
        // desenhar a barra superior.
        tenant: tenant ? { id: tenant.id, name: tenant.name, slug: tenant.slug } : null,
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
