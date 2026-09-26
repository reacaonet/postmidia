import type { NextFunction, Request, Response } from 'express';
import { env } from '../config';
import { signToken, verifyToken, type UserRole } from '../security/jwt';

export interface AuthenticatedRequest extends Request {
  tenantId: string;
  userId: string;
  email: string;
  role: UserRole;
}

/** Alias mantido para os modulos que so precisam do tenant. */
export type TenantRequest = AuthenticatedRequest;

const bearerToken = (req: Request): string | null => {
  const header = req.header('authorization');
  if (!header?.startsWith('Bearer ')) {
    return null;
  }
  const token = header.slice(7).trim();
  return token.length > 0 ? token : null;
};

const deny = (res: Response, status: number, error: string): void => {
  res.status(status).json({ success: false, error });
};

/**
 * Autenticacao no contexto de um tenant.
 *
 * O token Bearer e a via confiavel. O header `x-tenant-id` nao carrega
 * assinatura, entao so e aceito com ALLOW_TENANT_HEADER=true - que
 * `src/store/index.ts` recusa em producao, no boot.
 */
export const requireTenant = (req: Request, res: Response, next: NextFunction): void => {
  const token = bearerToken(req);

  if (token) {
    const claims = verifyToken(token);
    if (!claims) {
      deny(res, 401, 'Token invalido ou expirado');
      return;
    }

    const request = req as AuthenticatedRequest;
    request.tenantId = claims.tenantId;
    request.userId = claims.sub;
    request.email = claims.email;
    request.role = claims.role;
    next();
    return;
  }

  if (env.ALLOW_TENANT_HEADER) {
    const tenantId = req.header('x-tenant-id');
    if (tenantId) {
      const request = req as AuthenticatedRequest;
      request.tenantId = tenantId;
      request.userId = 'dev-header';
      request.email = 'dev@localhost';
      request.role = 'owner';
      next();
      return;
    }
  }

  deny(
    res,
    401,
    env.ALLOW_TENANT_HEADER
      ? 'Informe Authorization: Bearer <token> ou o header x-tenant-id (apenas em desenvolvimento)'
      : 'Authorization: Bearer <token> ausente'
  );
};

export const requireRole =
  (...roles: UserRole[]) =>
  (req: Request, res: Response, next: NextFunction): void => {
    const role = (req as AuthenticatedRequest).role;
    if (!role) {
      deny(res, 401, 'Autenticacao ausente');
      return;
    }
    if (!roles.includes(role)) {
      deny(res, 403, `Papel ${role} nao pode executar esta operacao; requer ${roles.join(' ou ')}`);
      return;
    }
    next();
  };

export { signToken };
