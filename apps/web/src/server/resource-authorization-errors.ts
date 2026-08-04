/**
 * Typed errors for the server-only resource authorization foundation.
 * Wire shape matches other platform APIs: `{ error: { code, message } }`.
 */
export type ResourceAuthorizationErrorCode =
  | 'invalid_subject'
  | 'capability_unavailable'
  | 'configuration_error'
  | 'denied';

export class ResourceAuthorizationError extends Error {
  constructor(
    message: string,
    public readonly code: ResourceAuthorizationErrorCode,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'ResourceAuthorizationError';
  }
}
