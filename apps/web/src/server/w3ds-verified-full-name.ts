import {
  isReplaceableWithVerifiedFullName,
  isValidPublicDisplayName,
} from '../lib/public-display-name';

/**
 * Official eID Wallet `fetchNameFromVault` (eid-wallet `socialBinding.ts`)
 * reads the verified passport name with this GraphQL operation. Meshenger's
 * browser then surfaces it as `{ user: { displayName } }` from its private
 * `GET /api/w3ds/users/:eName` wrapper — that HTTP path is not a public W3DS
 * contract. Vidak uses the documented query and the `id_document.data.name`
 * field only.
 */
export const VERIFIED_FULL_NAME_BINDING_QUERY = `
    query($type: BindingDocumentType!) {
        bindingDocuments(type: $type, first: 10) {
            edges {
                node {
                    id
                    parsed
                }
            }
        }
    }
`;

export const VERIFIED_FULL_NAME_BINDING_TYPE = 'id_document' as const;

const requestTimeoutMs = 12_000;

export type VerifiedFullNameErrorCode =
  | 'consent_required'
  | 'name_not_replaceable'
  | 'name_unavailable'
  | 'identity_mismatch'
  | 'invalid_name'
  | 'not_configured'
  | 'remote_unavailable'
  | 'remote_rejected';

export class VerifiedFullNameError extends Error {
  constructor(
    message: string,
    public readonly code: VerifiedFullNameErrorCode,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'VerifiedFullNameError';
  }
}

export interface VerifiedFullNameRecord {
  name: string;
  subject: string;
  type: typeof VERIFIED_FULL_NAME_BINDING_TYPE;
}

export interface VerifiedFullNameReader {
  readVerifiedFullName(input: {
    eName: string;
    eVaultUri: string;
  }): Promise<VerifiedFullNameRecord>;
}

export function normalizeEName(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  return trimmed.startsWith('@') ? trimmed : `@${trimmed}`;
}

/**
 * Bind `id_document.data.name` to the authenticated eName. Fail closed on a
 * missing document, a subject mismatch, or an identifier-shaped name.
 */
export function extractVerifiedFullNameFromBindingDocuments(input: {
  authenticatedEName: string;
  edges: unknown;
}): VerifiedFullNameRecord {
  const authenticatedEName = normalizeEName(input.authenticatedEName);
  if (!authenticatedEName.startsWith('@')) {
    throw new VerifiedFullNameError(
      'The authenticated identity is not a valid eName.',
      'identity_mismatch',
      403,
    );
  }

  const edges = Array.isArray(input.edges) ? input.edges : [];
  let sawIdDocument = false;
  let sawMismatchedSubject = false;

  for (const edge of edges) {
    const parsed = isRecord(edge) ? record(record(edge.node)?.parsed) : undefined;
    if (!parsed) continue;
    if (parsed.type !== VERIFIED_FULL_NAME_BINDING_TYPE) continue;
    sawIdDocument = true;

    const subject = typeof parsed.subject === 'string' ? normalizeEName(parsed.subject) : '';
    if (subject !== authenticatedEName) {
      sawMismatchedSubject = true;
      continue;
    }

    const data = record(parsed.data);
    const name = typeof data?.name === 'string' ? data.name.trim() : '';
    if (!isValidPublicDisplayName(name, { eName: authenticatedEName })) {
      throw new VerifiedFullNameError(
        'The verified name is not a usable public name.',
        'invalid_name',
        422,
      );
    }
    return { name, subject, type: VERIFIED_FULL_NAME_BINDING_TYPE };
  }

  if (sawMismatchedSubject) {
    throw new VerifiedFullNameError(
      'The identity document does not belong to this eName.',
      'identity_mismatch',
      403,
    );
  }
  if (sawIdDocument) {
    throw new VerifiedFullNameError(
      'The verified name is not a usable public name.',
      'invalid_name',
      422,
    );
  }
  throw new VerifiedFullNameError(
    'No verified identity document name is available.',
    'name_unavailable',
    404,
  );
}

export function assertReplaceablePublicName(
  displayName: string,
  identity: { id?: string; eName?: string; eVaultId?: string },
): void {
  if (!isReplaceableWithVerifiedFullName(displayName, identity)) {
    throw new VerifiedFullNameError(
      'Your public name was already set and will not be overwritten.',
      'name_not_replaceable',
      409,
    );
  }
}

export interface VerifiedFullNameClientConfig {
  registryBaseUrl: string;
  platformName: string;
  fetcher?: typeof fetch;
}

/**
 * Platform-token + X-ENAME GraphQL read, matching Meshenger's vault access
 * pattern and the eID Wallet `vaultGqlRequest` headers.
 */
export class RegistryVerifiedFullNameReader implements VerifiedFullNameReader {
  private platformToken: Promise<string> | undefined;
  private readonly fetcher: typeof fetch;

  constructor(private readonly config: VerifiedFullNameClientConfig) {
    this.fetcher = config.fetcher ?? fetch;
  }

  async readVerifiedFullName(input: {
    eName: string;
    eVaultUri: string;
  }): Promise<VerifiedFullNameRecord> {
    const eName = normalizeEName(input.eName);
    const eVaultUri = httpUrl(input.eVaultUri);
    const token = await this.getPlatformToken();
    const body = record(
      await this.requestJson(new URL('/graphql', eVaultUri), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-ENAME': eName,
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          query: VERIFIED_FULL_NAME_BINDING_QUERY,
          variables: { type: VERIFIED_FULL_NAME_BINDING_TYPE },
        }),
      }),
    );
    if (Array.isArray(body?.errors) && body.errors.length) {
      throw new VerifiedFullNameError(
        'The eVault rejected the verified-name request.',
        'remote_rejected',
        502,
      );
    }
    const data = record(body?.data);
    const connection = record(data?.bindingDocuments);
    return extractVerifiedFullNameFromBindingDocuments({
      authenticatedEName: eName,
      edges: connection?.edges,
    });
  }

  private async getPlatformToken(): Promise<string> {
    if (!this.platformToken) this.platformToken = this.requestPlatformToken();
    try {
      return await this.platformToken;
    } catch (error) {
      this.platformToken = undefined;
      throw error;
    }
  }

  private async requestPlatformToken(): Promise<string> {
    const payload = record(
      await this.requestJson(new URL('/platforms/certification', this.config.registryBaseUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform: this.config.platformName }),
      }),
    );
    const token = optionalString(payload?.token);
    if (!token) {
      throw new VerifiedFullNameError(
        'The W3DS registry did not issue a platform credential.',
        'remote_rejected',
        502,
      );
    }
    return token;
  }

  private async requestJson(url: URL, init: RequestInit): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetcher(url, {
        ...init,
        cache: 'no-store',
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
    } catch {
      throw new VerifiedFullNameError(
        'The W3DS identity source is unavailable.',
        'remote_unavailable',
        503,
      );
    }
    if (!response.ok) {
      throw new VerifiedFullNameError(
        'The W3DS identity source rejected the request.',
        'remote_rejected',
        502,
      );
    }
    try {
      return await response.json();
    } catch {
      throw new VerifiedFullNameError(
        'The W3DS identity source returned invalid data.',
        'remote_rejected',
        502,
      );
    }
  }
}

export function createVerifiedFullNameReader(
  env: Record<string, string | undefined> = process.env,
): VerifiedFullNameReader {
  const registry = env.W3DS_REGISTRY_BASE_URL?.trim();
  if (!registry) {
    throw new VerifiedFullNameError(
      'Verified full name is not configured for this Vidak deployment.',
      'not_configured',
      503,
    );
  }
  return new RegistryVerifiedFullNameReader({
    registryBaseUrl: httpUrl(registry),
    platformName: env.W3DS_AUTH_PLATFORM_NAME?.trim() || 'vidak',
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function httpUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new VerifiedFullNameError(
      'The W3DS identity source rejected the request.',
      'remote_rejected',
      502,
    );
  }
  return url.toString();
}
