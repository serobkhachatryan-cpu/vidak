/**
 * Typed errors for durable W3DS authorization synchronization.
 * Wire shape matches other platform APIs: `{ error: { code, message } }`.
 * Messages must never include credentials, tokens, or raw remote payloads.
 */
export type W3dsAuthorizationSyncErrorCode =
  | 'configuration_error'
  | 'capability_unavailable'
  | 'sdk_unavailable'
  | 'sync_failed'
  | 'invalid_subject'
  | 'invalid_resource';

export class W3dsAuthorizationSyncError extends Error {
  constructor(
    message: string,
    public readonly code: W3dsAuthorizationSyncErrorCode,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'W3dsAuthorizationSyncError';
  }
}
