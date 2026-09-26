import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { env } from '../config';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;

const key = Buffer.from(env.TOKEN_ENCRYPTION_KEY, 'hex');

export const encryptSecret = (plaintext: string): string => {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString('base64'), authTag.toString('base64'), encrypted.toString('base64')].join('.');
};

export const decryptSecret = (payload: string): string => {
  const [ivPart, tagPart, dataPart] = payload.split('.');
  if (!ivPart || !tagPart || !dataPart) {
    throw new Error('Segredo cifrado em formato invalido');
  }
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivPart, 'base64'));
  decipher.setAuthTag(Buffer.from(tagPart, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataPart, 'base64')),
    decipher.final(),
  ]).toString('utf8');
};
