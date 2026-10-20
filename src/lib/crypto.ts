import crypto from 'crypto';
import { config } from '../config/env.js';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

export function getKey(): Buffer {
  const raw = config.ENCRYPTION_KEY || 'reachinbox-scheduler-32-byte-key';

  // 1. Try decoding as 32-byte base64 string
  if (raw.length === 44 && raw.endsWith('=')) {
    try {
      const buf = Buffer.from(raw, 'base64');
      if (buf.length === 32) return buf;
    } catch {}
  }

  // 2. Try hex if 64 hex chars
  if (raw.length === 64 && /^[0-9a-fA-F]+$/.test(raw)) {
    try {
      const buf = Buffer.from(raw, 'hex');
      if (buf.length === 32) return buf;
    } catch {}
  }

  // 3. Fallback: Stable SHA-256 digest guaranteed to be exactly 32 bytes
  return crypto.createHash('sha256').update(raw).digest();
}

export function encrypt(text: string): string {
  if (!text) return '';
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

export function decrypt(encryptedBase64: string): string {
  if (!encryptedBase64) return '';

  const attemptDecryptWithKey = (keyBuf: Buffer): string => {
    const data = Buffer.from(encryptedBase64, 'base64');
    if (data.length < IV_LENGTH + AUTH_TAG_LENGTH) return '';
    const iv = data.subarray(0, IV_LENGTH);
    const tag = data.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
    const text = data.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
    const decipher = crypto.createDecipheriv(ALGORITHM, keyBuf, iv);
    decipher.setAuthTag(tag);
    return decipher.update(text) + decipher.final('utf8');
  };

  // Primary attempt with standard key
  try {
    return attemptDecryptWithKey(getKey());
  } catch (err: any) {
    // Secondary attempt with legacy substring key if key changed
    try {
      const raw = config.ENCRYPTION_KEY || '';
      const legacyKey = Buffer.from(raw.padEnd(32, '0').substring(0, 32));
      return attemptDecryptWithKey(legacyKey);
    } catch {}

    // Third attempt with default key
    try {
      const defaultKey = crypto.createHash('sha256').update('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef').digest();
      return attemptDecryptWithKey(defaultKey);
    } catch {}

    return '';
  }
}
