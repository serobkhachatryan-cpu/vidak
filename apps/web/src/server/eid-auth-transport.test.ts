import { describe, expect, it } from 'vitest';
import { normalizeEidAuthPayload } from './eid-auth-transport';

describe('normalizeEidAuthPayload', () => {
  it('maps the eID Wallet ename field to the verified W3DS identity field', () => {
    expect(
      normalizeEidAuthPayload({
        ename: '@creator.w3id',
        session: 'session-1',
        signature: 'signature-1',
        appVersion: '0.4.0',
      }),
    ).toEqual({
      w3id: '@creator.w3id',
      session: 'session-1',
      signature: 'signature-1',
      appVersion: '0.4.0',
    });
  });
});
