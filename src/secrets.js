// Authenticated encryption for sensitive state. Record IDs are bound as AAD.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { config } from './config.js';

const IV_LEN = 12;

export function seal(plaintext, aad = '') {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', config.dataKey, iv);
  if (aad) cipher.setAAD(Buffer.from(aad, 'utf8'));
  const body = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${body.toString('hex')}`;
}

export function open(blob, aad = '') {
  const [ivHex, tagHex, bodyHex] = String(blob).split(':');
  if (!ivHex || !tagHex || !bodyHex) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', config.dataKey, Buffer.from(ivHex, 'hex'));
    if (aad) decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    const out = Buffer.concat([decipher.update(Buffer.from(bodyHex, 'hex')), decipher.final()]);
    return out.toString('utf8');
  } catch {
    // Authentication failures are reported as unreadable records.
    return null;
  }
}
