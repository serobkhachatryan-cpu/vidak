import { describe, expect, it } from 'vitest';
import {
  decryptChannelImportCredential,
  encryptChannelImportCredential,
} from './channel-import-crypto';

describe('channel-import credential encryption', () => {
  it('uses authenticated encryption and rejects a modified value', () => {
    const key = Buffer.alloc(32, 4);
    const encrypted = encryptChannelImportCredential('provider-token', key);
    expect(encrypted).not.toContain('provider-token');
    expect(decryptChannelImportCredential(encrypted, key)).toBe('provider-token');
    const [entryVersion, iv, tag, ciphertext] = encrypted.split('.');
    if (!entryVersion || !iv || !tag || !ciphertext)
      throw new Error('Encrypted value is malformed.');
    const changedTag = `${tag[0] === 'A' ? 'B' : 'A'}${tag.slice(1)}`;
    const tampered = `${entryVersion}.${iv}.${changedTag}.${ciphertext}`;
    expect(() => decryptChannelImportCredential(tampered, key)).toThrow('cannot be decrypted');
  });
});
