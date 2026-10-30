import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

function encryptionKey(): Buffer {
  const value = process.env.AI_KEY_ENCRYPTION_KEY?.trim() ?? '';
  if (!/^[a-fA-F0-9]{64}$/.test(value)) {
    throw new Error('AI_KEY_ENCRYPTION_KEY must be 32 bytes encoded as 64 hexadecimal characters.');
  }
  return Buffer.from(value, 'hex');
}

export function encryptSecret(secret: string): { ciphertext: string; iv: string; authTag: string } {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
  };
}

export function decryptSecret(payload: { ciphertext: string; iv: string; authTag: string }): string {
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(payload.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(payload.authTag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}
