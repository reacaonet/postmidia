import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number
) => Promise<Buffer>;

const PARAMS = { N: 16384, r: 8, p: 1 };
const KEY_LENGTH = 64;
const SALT_BYTES = 16;

export const hashPassword = async (password: string): Promise<string> => {
  const salt = randomBytes(SALT_BYTES);
  const derived = await scrypt(password, salt, KEY_LENGTH);
  return ['scrypt', PARAMS.N, PARAMS.r, PARAMS.p, salt.toString('base64'), derived.toString('base64')].join('$');
};

export const verifyPassword = async (password: string, stored: string): Promise<boolean> => {
  const [scheme, n, r, p, saltPart, hashPart] = stored.split('$');

  if (scheme !== 'scrypt' || !n || !r || !p || !saltPart || !hashPart) {
    return false;
  }

  const expected = Buffer.from(hashPart, 'base64');
  const derived = await scrypt(password, Buffer.from(saltPart, 'base64'), expected.length);

  if (derived.length !== expected.length) {
    return false;
  }

  return timingSafeEqual(derived, expected);
};

/**
 * Custo fixo para nao vazar por tempo de resposta se o e-mail nao existir.
 * Retorna false mas ainda paga o scrypt.
 */
const DUMMY_HASH =
  'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==';

export const burnPasswordCheck = async (password: string): Promise<void> => {
  await verifyPassword(password, DUMMY_HASH);
};
