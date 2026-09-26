import jwt, { type SignOptions } from 'jsonwebtoken';
import { env } from '../config';

export type UserRole = 'owner' | 'admin' | 'member';

export interface AuthClaims {
  sub: string;
  tenantId: string;
  email: string;
  role: UserRole;
}

const SIGN_OPTIONS: SignOptions = {
  algorithm: 'HS256',
  expiresIn: env.JWT_TTL as SignOptions['expiresIn'],
  issuer: 'postmidia',
};

export const signToken = (claims: AuthClaims): string => jwt.sign(claims, env.JWT_SECRET, SIGN_OPTIONS);

export const verifyToken = (token: string): AuthClaims | null => {
  try {
    const decoded = jwt.verify(token, env.JWT_SECRET, {
      algorithms: ['HS256'],
      issuer: 'postmidia',
    });

    if (typeof decoded === 'string') {
      return null;
    }

    const { sub, tenantId, email, role } = decoded as Partial<AuthClaims>;
    if (!sub || !tenantId || !email || !role) {
      return null;
    }

    return { sub, tenantId, email, role };
  } catch {
    return null;
  }
};
