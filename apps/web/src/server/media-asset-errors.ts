/**
 * Typed errors for durable media asset persistence.
 * Same wire shape as auth / draft errors: `{ error: { code, message } }`.
 */
export class MediaAssetError extends Error {
  readonly responseHeaders?: Readonly<Record<string, string>>;

  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number,
    options?: { headers?: Readonly<Record<string, string>> },
  ) {
    super(message);
    this.name = 'MediaAssetError';
    if (options?.headers) {
      this.responseHeaders = options.headers;
    }
  }
}
