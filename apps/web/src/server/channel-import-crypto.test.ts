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
    expect(() => decryptChannelImportCredential(encrypted.slice(0, -1) + 'x', key)).toThrow(
      'cannot be decrypted',
    );
  });
});
