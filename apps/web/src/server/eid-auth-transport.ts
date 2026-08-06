import type { W3dsCallbackInput } from './w3ds-auth';

/**
 * Converts the eID Wallet transport payload into the platform's verified
 * authentication input. The wallet calls the W3ID field `ename`; the
 * platform domain model calls the same value `w3id`.
 */
export function normalizeEidAuthPayload(value: unknown): W3dsCallbackInput {
  const payload = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const eName = typeof payload.ename === 'string' ? payload.ename : payload.w3id;

  return {
    w3id: typeof eName === 'string' ? eName : '',
    session: typeof payload.session === 'string' ? payload.session : '',
    signature: typeof payload.signature === 'string' ? payload.signature : '',
    ...(typeof payload.appVersion === 'string' ? { appVersion: payload.appVersion } : {}),
  };
}
