/**
 * Typed errors for durable media asset persistence.
 * Same wire shape as auth / draft errors: `{ error: { code, message } }`.
 */
export class MediaAssetError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'MediaAssetError';
  }
}
