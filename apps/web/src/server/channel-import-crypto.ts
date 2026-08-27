import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const version = 'v1';

/**
 * Authenticated encryption for provider credentials at rest. Values must stay
 * server-only and should never be placed in logs or thrown errors.
 */
export function encryptChannelImportCredential(value: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [version, iv.toString('base64url'), tag.toString('base64url'), encrypted.toString('base64url')].join('.');
}

export function decryptChannelImportCredential(value: string, key: Buffer): string {
  const [entryVersion, ivValue, tagValue, encryptedValue, ...rest] = value.split('.');
  if (
    entryVersion !== version ||
    !ivValue ||
    !tagValue ||
    !encryptedValue ||
    rest.length > 0
  ) {
    throw new Error('Channel-import credential cannot be decrypted.');
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivValue, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(encryptedValue, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new Error('Channel-import credential cannot be decrypted.');
  }
}
