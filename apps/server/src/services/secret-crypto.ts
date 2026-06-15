import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

// Reversible encryption for settings secrets (e.g. the MikroTik password) so
// they are never stored in the DB in plaintext. We need the real password back
// to send it as HTTP Basic auth to RouterOS, so a one-way hash is not an option.
//
// Scheme: AES-256-CBC. Key = SHA-256(MIKROTIK_SECRET). Stored as
//   "enc:v1:" + base64(iv[16] || ciphertext)
// The .225 sync script decrypts the same way with the same env secret.
//
// If MIKROTIK_SECRET is not set we fall back to a clearly-marked "plain:" prefix
// (NOT encrypted) and log a warning, so the feature still works before the key
// is configured — set MIKROTIK_SECRET on the API host and on the sync host to
// get real encryption.

const ENC_PREFIX = 'enc:v1:';
const PLAIN_PREFIX = 'plain:';

function keyBytes(): Buffer | null {
  const secret = process.env.MIKROTIK_SECRET;
  if (!secret) return null;
  return createHash('sha256').update(secret, 'utf8').digest();
}

export function encryptSecret(plain: string): string {
  const key = keyBytes();
  if (!key) {
    console.warn('MIKROTIK_SECRET not set — storing the MikroTik password WITHOUT encryption. Set MIKROTIK_SECRET to encrypt it.');
    return PLAIN_PREFIX + plain;
  }
  const iv = randomBytes(16);
  const c = createCipheriv('aes-256-cbc', key, iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ENC_PREFIX + Buffer.concat([iv, enc]).toString('base64');
}

export function decryptSecret(stored: string): string {
  if (stored.startsWith(PLAIN_PREFIX)) return stored.slice(PLAIN_PREFIX.length);
  if (!stored.startsWith(ENC_PREFIX)) return stored; // legacy / unknown — treat as plaintext
  const key = keyBytes();
  if (!key) throw new Error('MIKROTIK_SECRET not set — cannot decrypt stored secret');
  const raw = Buffer.from(stored.slice(ENC_PREFIX.length), 'base64');
  const iv = raw.subarray(0, 16);
  const ct = raw.subarray(16);
  const d = createDecipheriv('aes-256-cbc', key, iv);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

export function isEncrypted(stored: string | undefined): boolean {
  return !!stored && (stored.startsWith(ENC_PREFIX) || stored.startsWith(PLAIN_PREFIX));
}
