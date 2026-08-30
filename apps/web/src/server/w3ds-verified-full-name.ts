import {
  isReplaceableWithVerifiedFullName,
  isValidPublicDisplayName,
} from '../lib/public-display-name';

/**
 * Official eID Wallet `fetchNameFromVault` (eid-wallet `socialBinding.ts`).
 * Meshenger’s private `GET /api/w3ds/users/:eName` is not a public W3DS
 * contract; this is the documented GraphQL path it wraps.
 *
 * Priority: id_document.data.name > self.data.name > User ontology displayName.
 * Queries use `node { id parsed }` and `X-ENAME` of the vault owner.
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

export const VERIFIED_FULL_NAME_USER_PROFILE_QUERY = `
    query GetUserProfile($ontologyId: ID!) {
        metaEnvelopes(filter: { ontologyId: $ontologyId }, first: 1) {
            edges {
                node {
                    parsed
                }
            }
        }
    }
`;

export const VERIFIED_FULL_NAME_BINDING_TYPE = 'id_document' as const;
export const VERIFIED_FULL_NAME_SELF_TYPE = 'self' as const;
/** Canonical User ontology W3ID (Ontology service / eID Wallet). */
export const VERIFIED_FULL_NAME_USER_ONTOLOGY_ID = '550e8400-e29b-41d4-a716-446655440000';

const requestTimeoutMs = 12_000;

export type VerifiedFullNameErrorCode =
  | 'consent_required'
  | 'name_not_replaceable'
  | 'name_unavailable'
  | 'identity_mismatch'
  | 'invalid_name'
  | 'not_configured'
  | 'remote_unavailable'
  | 'authorization_denied'
  | 'parse_failure'
  | 'remote_rejected';

/** Safe diagnostic tokens. Never include names, eNames, IDs, tokens, or documents. */
export type VerifiedFullNameReason =
  | 'ready'
  | 'source_unconfigured'
  | 'source_unavailable'
  | 'authorization_denied'
  | 'parse_failure'
  | 'identity_mismatch'
  | 'name_unavailable'
  | 'invalid_name'
  | 'name_not_replaceable'
  | 'consent_required';

export class VerifiedFullNameError extends Error {
  constructor(
    message: string,
    public readonly code: VerifiedFullNameErrorCode,
    public readonly status: number,
    public readonly reason: VerifiedFullNameReason = codeToReason(code),
  ) {
    super(message);
    this.name = 'VerifiedFullNameError';
  }
}

export type VerifiedFullNameSource =
  | typeof VERIFIED_FULL_NAME_BINDING_TYPE
  | typeof VERIFIED_FULL_NAME_SELF_TYPE
  | 'user_profile';

export interface VerifiedFullNameRecord {
  name: string;
  subject: string;
  type: VerifiedFullNameSource;
}

export interface VerifiedFullNameReader {
  readVerifiedFullName(input: { eName: string; eVaultUri?: string }): Promise<VerifiedFullNameRecord>;
}

export function normalizeEName(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  return trimmed.startsWith('@') ? trimmed : `@${trimmed}`;
}

function codeToReason(code: VerifiedFullNameErrorCode): VerifiedFullNameReason {
  if (code === 'not_configured') return 'source_unconfigured';
  if (code === 'remote_unavailable' || code === 'remote_rejected') return 'source_unavailable';
  if (
    code === 'consent_required' ||
    code === 'name_not_replaceable' ||
    code === 'name_unavailable' ||
    code === 'identity_mismatch' ||
    code === 'invalid_name' ||
    code === 'authorization_denied' ||
    code === 'parse_failure'
  ) {
    return code;
  }
  return 'source_unavailable';
}

function parseRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === 'string') {
    try {
      return record(JSON.parse(value));
    } catch {
      return undefined;
    }
  }
  return record(value);
}

function bindingFields(edge: unknown): {
  type: string;
  subject: string;
  name: string;
} | undefined {
  const node = isRecord(edge) ? record(edge.node) : undefined;
  if (!node) return undefined;
  const parsed = parseRecord(node.parsed);
  const type =
    (typeof parsed?.type === 'string' && parsed.type) ||
    (typeof node.type === 'string' && node.type) ||
    '';
  const subjectRaw =
    (typeof parsed?.subject === 'string' && parsed.subject) ||
    (typeof node.subject === 'string' && node.subject) ||
    '';
  const data = parseRecord(parsed?.data) ?? parseRecord(node.data);
  const name = typeof data?.name === 'string' ? data.name.trim() : '';
  return { type, subject: subjectRaw ? normalizeEName(subjectRaw) : '', name };
}

/**
 * eID `fetchNameFromVault` priority over binding-document edges.
 * X-ENAME already scopes the query to the vault owner. A missing subject is
 * treated as owner-scoped. A different eName subject is not used.
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
  let selfMatch: VerifiedFullNameRecord | undefined;
  let sawMismatchedSubject = false;
  let sawInvalidName = false;

  for (const edge of edges) {
    const fields = bindingFields(edge);
    if (!fields) continue;
    if (fields.subject && fields.subject !== authenticatedEName) {
      sawMismatchedSubject = true;
      continue;
    }
    if (fields.type !== VERIFIED_FULL_NAME_BINDING_TYPE && fields.type !== VERIFIED_FULL_NAME_SELF_TYPE) {
      continue;
    }
    if (!isValidPublicDisplayName(fields.name, { eName: authenticatedEName })) {
      if (fields.name) sawInvalidName = true;
      continue;
    }
    const recordValue: VerifiedFullNameRecord = {
      name: fields.name,
      subject: authenticatedEName,
      type: fields.type,
    };
    if (fields.type === VERIFIED_FULL_NAME_BINDING_TYPE) return recordValue;
    selfMatch ??= recordValue;
  }

  if (selfMatch) return selfMatch;
  if (sawInvalidName) {
    throw new VerifiedFullNameError(
      'The verified name is not a usable public name.',
      'invalid_name',
      422,
    );
  }
  if (sawMismatchedSubject) {
    throw new VerifiedFullNameError(
      'The identity document does not belong to this eName.',
      'identity_mismatch',
      403,
    );
  }
  throw new VerifiedFullNameError(
    'No verified identity document name is available.',
    'name_unavailable',
    404,
  );
}

export function extractVerifiedFullNameFromUserProfile(input: {
  authenticatedEName: string;
  edges: unknown;
}): VerifiedFullNameRecord {
  const authenticatedEName = normalizeEName(input.authenticatedEName);
  const edges = Array.isArray(input.edges) ? input.edges : [];
  const node = isRecord(edges[0]) ? record(edges[0].node) : undefined;
  const parsed = parseRecord(node?.parsed);
  const name = typeof parsed?.displayName === 'string' ? parsed.displayName.trim() : '';
  if (!isValidPublicDisplayName(name, { eName: authenticatedEName })) {
    throw new VerifiedFullNameError(
      'No verified identity document name is available.',
      'name_unavailable',
      404,
    );
  }
  return { name, subject: authenticatedEName, type: 'user_profile' };
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
 * Registry resolve + platform-token + X-ENAME GraphQL read, matching eID
 * `vaultGqlRequest` / `fetchNameFromVault` and Meshenger video-library access.
 */
export class RegistryVerifiedFullNameReader implements VerifiedFullNameReader {
  private platformToken: Promise<string> | undefined;
  private readonly fetcher: typeof fetch;

  constructor(private readonly config: VerifiedFullNameClientConfig) {
    this.fetcher = config.fetcher ?? fetch;
  }

  async readVerifiedFullName(input: {
    eName: string;
    eVaultUri?: string;
  }): Promise<VerifiedFullNameRecord> {
    const eName = normalizeEName(input.eName);
    const eVaultUri = await this.resolveEVaultUri(eName, input.eVaultUri);
    const token = await this.getPlatformToken();
    const binding = await this.readBindingName(eVaultUri, eName, token);
    if (binding.record) return binding.record;
    const profile = await this.readUserProfileName(eVaultUri, eName, token);
    if (profile.record) return profile.record;
    throw preferredVerifiedFullNameFailure(binding.error, profile.error);
  }

  private async readBindingName(
    graphqlUrl: string,
    eName: string,
    token: string,
  ): Promise<{ record?: VerifiedFullNameRecord; error?: VerifiedFullNameError }> {
    try {
      const [idDocuments, selfDocuments] = await Promise.all([
        this.bindingDocuments(graphqlUrl, eName, token, VERIFIED_FULL_NAME_BINDING_TYPE),
        this.bindingDocuments(graphqlUrl, eName, token, VERIFIED_FULL_NAME_SELF_TYPE),
      ]);
      return {
        record: extractVerifiedFullNameFromBindingDocuments({
          authenticatedEName: eName,
          edges: [...idDocuments, ...selfDocuments],
        }),
      };
    } catch (error) {
      return { error: asVerifiedFullNameError(error) };
    }
  }

  private async readUserProfileName(
    graphqlUrl: string,
    eName: string,
    token: string,
  ): Promise<{ record?: VerifiedFullNameRecord; error?: VerifiedFullNameError }> {
    try {
      const edges = await this.userProfile(graphqlUrl, eName, token);
      return {
        record: extractVerifiedFullNameFromUserProfile({
          authenticatedEName: eName,
          edges,
        }),
      };
    } catch (error) {
      return { error: asVerifiedFullNameError(error) };
    }
  }

  private async resolveEVaultUri(eName: string, storedUri?: string): Promise<string> {
    const resolveUrl = new URL('/resolve', this.config.registryBaseUrl);
    resolveUrl.searchParams.set('w3id', eName);
    try {
      const resolved = record(await this.requestJson(resolveUrl, { method: 'GET' }));
      const uri = optionalString(resolved?.uri);
      if (!uri) {
        throw new VerifiedFullNameError(
          'The W3DS identity source is unavailable.',
          'remote_unavailable',
          503,
          'source_unavailable',
        );
      }
      const resolvedEName = optionalString(resolved?.ename);
      if (resolvedEName && normalizeEName(resolvedEName) !== eName) {
        throw new VerifiedFullNameError(
          'The identity document does not belong to this eName.',
          'identity_mismatch',
          403,
        );
      }
      return graphqlUrlFromVaultUri(uri);
    } catch (error) {
      const stored = storedUri?.trim();
      if (stored) return graphqlUrlFromVaultUri(stored);
      throw asVerifiedFullNameError(error);
    }
  }

  private async bindingDocuments(
    graphqlUrl: string,
    eName: string,
    token: string,
    type: typeof VERIFIED_FULL_NAME_BINDING_TYPE | typeof VERIFIED_FULL_NAME_SELF_TYPE,
  ): Promise<unknown[]> {
    const body = record(
      await this.requestJson(new URL(graphqlUrl), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-ENAME': eName,
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          query: VERIFIED_FULL_NAME_BINDING_QUERY,
          variables: { type },
        }),
      }),
    );
    this.assertGraphqlData(body);
    const connection = record(record(body?.data)?.bindingDocuments);
    return Array.isArray(connection?.edges) ? connection.edges : [];
  }

  private async userProfile(graphqlUrl: string, eName: string, token: string): Promise<unknown[]> {
    const body = record(
      await this.requestJson(new URL(graphqlUrl), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-ENAME': eName,
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          query: VERIFIED_FULL_NAME_USER_PROFILE_QUERY,
          variables: { ontologyId: VERIFIED_FULL_NAME_USER_ONTOLOGY_ID },
        }),
      }),
    );
    this.assertGraphqlData(body);
    const connection = record(record(body?.data)?.metaEnvelopes);
    return Array.isArray(connection?.edges) ? connection.edges : [];
  }

  private assertGraphqlData(body: Record<string, unknown> | undefined): void {
    if (Array.isArray(body?.errors) && body.errors.length) {
      throw classifyGraphqlErrors(body.errors);
    }
    if (!record(body?.data)) {
      throw new VerifiedFullNameError(
        'The W3DS identity source returned invalid data.',
        'parse_failure',
        502,
      );
    }
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
        'authorization_denied',
        502,
        'authorization_denied',
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
        'source_unavailable',
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw new VerifiedFullNameError(
        'Vidak is not allowed to read the verified name.',
        'authorization_denied',
        403,
      );
    }
    if (!response.ok) {
      throw new VerifiedFullNameError(
        'The W3DS identity source is unavailable.',
        'remote_unavailable',
        503,
        'source_unavailable',
      );
    }
    try {
      return await response.json();
    } catch {
      throw new VerifiedFullNameError(
        'The W3DS identity source returned invalid data.',
        'parse_failure',
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

function preferredVerifiedFullNameFailure(
  bindingError?: VerifiedFullNameError,
  profileError?: VerifiedFullNameError,
): VerifiedFullNameError {
  const failures = [bindingError, profileError].filter(
    (error): error is VerifiedFullNameError =>
      error !== undefined && error.code !== 'name_unavailable',
  );
  const authorization = failures.find((error) => error.code === 'authorization_denied');
  if (authorization) return authorization;
  const source = failures.find(
    (error) => error.code === 'remote_unavailable' || error.code === 'remote_rejected' || error.code === 'not_configured',
  );
  if (source) return source;
  const parse = failures.find((error) => error.code === 'parse_failure');
  if (parse) return parse;
  const mismatch = failures.find((error) => error.code === 'identity_mismatch');
  if (mismatch) return mismatch;
  const invalid = failures.find((error) => error.code === 'invalid_name');
  if (invalid) return invalid;
  if (failures[0]) return failures[0];
  return new VerifiedFullNameError(
    'No verified identity document name is available.',
    'name_unavailable',
    404,
  );
}

function asVerifiedFullNameError(error: unknown): VerifiedFullNameError {
  if (error instanceof VerifiedFullNameError) return error;
  return new VerifiedFullNameError(
    'The W3DS identity source is unavailable.',
    'remote_unavailable',
    503,
    'source_unavailable',
  );
}

function graphqlUrlFromVaultUri(uri: string): string {
  const normalized = httpUrl(uri);
  return normalized.endsWith('/graphql') ? normalized : new URL('/graphql', normalized).toString();
}

function classifyGraphqlErrors(errors: unknown): VerifiedFullNameError {
  const list = Array.isArray(errors) ? errors : [];
  for (const error of list) {
    const recordValue = record(error);
    const code = String(recordValue?.code ?? record(recordValue?.extensions)?.code ?? '').toUpperCase();
    const message = String(recordValue?.message ?? '').toLowerCase();
    if (
      code.includes('FORBIDDEN') ||
      code.includes('UNAUTHENTICATED') ||
      code.includes('UNAUTHORIZED') ||
      code.includes('ACL') ||
      message.includes('forbidden') ||
      message.includes('unauthorized') ||
      message.includes('unauthenticated') ||
      message.includes('access denied')
    ) {
      return new VerifiedFullNameError(
        'Vidak is not allowed to read the verified name.',
        'authorization_denied',
        403,
      );
    }
  }
  return new VerifiedFullNameError(
    'The W3DS identity source returned invalid data.',
    'parse_failure',
    502,
  );
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
      'The W3DS identity source is unavailable.',
      'remote_unavailable',
      503,
      'source_unavailable',
    );
  }
  return url.toString();
}
