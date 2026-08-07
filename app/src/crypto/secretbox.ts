/**
 * Symmetric encryption for stored Postgres credentials.
 *
 * Student database passwords must be *recoverable* (the app has to present
 * them to Postgres on every query), so unlike login passwords they are
 * encrypted rather than hashed. AES-256-GCM with a random 12-byte nonce.
 *
 * Key: DBK_ENCRYPTION_KEY, 32 raw bytes. Losing it makes every stored student
 * credential unrecoverable — recovery then means reprovisioning passwords with
 * ALTER ROLE, which is survivable but disruptive.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { config } from '../config.js';

const ALGORITHM = 'aes-256-gcm';
const NONCE_LENGTH = 12;
const TAG_LENGTH = 16;
const VERSION = 'v1';

/** Returns `v1.<nonce b64url>.<tag b64url>.<ciphertext b64url>`. */
export function encryptSecret(plaintext: string): string {
  const nonce = randomBytes(NONCE_LENGTH);
  const cipher = createCipheriv(ALGORITHM, config.secrets.encryptionKey, nonce, {
    authTagLength: TAG_LENGTH,
  });
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    nonce.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

export function decryptSecret(encoded: string): string {
  const parts = encoded.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error('Malformed encrypted secret.');
  }
  const nonce = Buffer.from(parts[1]!, 'base64url');
  const tag = Buffer.from(parts[2]!, 'base64url');
  const ciphertext = Buffer.from(parts[3]!, 'base64url');

  if (nonce.length !== NONCE_LENGTH || tag.length !== TAG_LENGTH) {
    throw new Error('Malformed encrypted secret.');
  }

  const decipher = createDecipheriv(ALGORITHM, config.secrets.encryptionKey, nonce, {
    authTagLength: TAG_LENGTH,
  });
  decipher.setAuthTag(tag);
  // Throws if the tag does not verify — i.e. wrong key or tampered ciphertext.
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
