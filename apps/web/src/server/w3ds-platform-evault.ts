import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getW3dsDatabase, type W3dsDatabase } from './db/client';
import { w3dsPlatformEVault } from './db/schema';
import type { W3dsPlatformEVaultConfig } from './server-config';

/** Stable local key for the one eVault owned by the Vidak platform. */
export const w3dsPlatformEVaultLocalId = 'vidak-platform';

/** User-profile ontology required by the Platform eVault registration guide. */
export const w3dsPlatformProfileOntology = '550e8400-e29b-41d4-a716-446655440000';

const requestTimeoutMs = 8_000;

export class W3dsPlatformEVaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'W3dsPlatformEVaultError';
  }
}

export interface W3dsPlatformEVaultRecord {
  id: string;
  eName: string;
  eVaultUri: string;
  profile: W3dsPlatformEVaultConfig['profile'];
  createdAt: number;
  updatedAt: number;
}

export interface CreatePlatformEVaultRecordInput {
  eName: string;
  eVaultUri: string;
  profile: W3dsPlatformEVaultConfig['profile'];
  now: number;
}

/** Durable mapping required to avoid provisioning a second platform eVault. */
export interface W3dsPlatformEVaultStore {
  get(): Promise<W3dsPlatformEVaultRecord | undefined>;
  createIfAbsent(input: CreatePlatformEVaultRecordInput): Promise<W3dsPlatformEVaultRecord>;
}

/** In-memory store for explicit unit tests only; production uses PostgreSQL. */
export class InMemoryW3dsPlatformEVaultStore implements W3dsPlatformEVaultStore {
  private record: W3dsPlatformEVaultRecord | undefined;

  async get(): Promise<W3dsPlatformEVaultRecord | undefined> {
    return this.record ? cloneRecord(this.record) : undefined;
  }

  async createIfAbsent(input: CreatePlatformEVaultRecordInput): Promise<W3dsPlatformEVaultRecord> {
    if (this.record) return cloneRecord(this.record);
    this.record = {
      id: w3dsPlatformEVaultLocalId,
      eName: input.eName,
      eVaultUri: input.eVaultUri,
      profile: { ...input.profile },
      createdAt: input.now,
      updatedAt: input.now,
    };
    return cloneRecord(this.record);
  }
}

/** PostgreSQL-backed store used by the Node server. */
export class PostgresW3dsPlatformEVaultStore implements W3dsPlatformEVaultStore {
  constructor(private readonly db: W3dsDatabase) {}

  async get(): Promise<W3dsPlatformEVaultRecord | undefined> {
    const [row] = await this.db
      .select()
      .from(w3dsPlatformEVault)
      .where(eq(w3dsPlatformEVault.id, w3dsPlatformEVaultLocalId))
      .limit(1);
    return row ? recordFromRow(row) : undefined;
  }

  async createIfAbsent(input: CreatePlatformEVaultRecordInput): Promise<W3dsPlatformEVaultRecord> {
    const [created] = await this.db
      .insert(w3dsPlatformEVault)
      .values({
        id: w3dsPlatformEVaultLocalId,
        eName: input.eName,
        eVaultUri: input.eVaultUri,
        platformName: input.profile.platformName,
        displayName: input.profile.displayName,
        description: input.profile.description,
        profileVersion: input.profile.version,
        publicUrl: input.profile.url,
        logoUrl: input.profile.logoUrl,
        category: input.profile.category,
        createdAt: new Date(input.now),
        updatedAt: new Date(input.now),
      })
      .onConflictDoNothing({ target: w3dsPlatformEVault.id })
      .returning();
    if (created) return recordFromRow(created);

    const record = await this.get();
    if (!record) {
      throw new W3dsPlatformEVaultError('Unable to persist the platform eVault mapping.');
    }
    return record;
  }
}

export interface W3dsPlatformEVaultRemoteClient {
  provision(input: { verificationId: string }): Promise<{ eName: string; eVaultUri: string }>;
  writePlatformProfile(input: {
    eName: string;
    eVaultUri: string;
    profile: W3dsPlatformEVaultConfig['profile'];
    now: number;
  }): Promise<void>;
}

export interface W3dsPlatformEVaultClientOptions {
  registryBaseUrl: string;
  provisionerBaseUrl: string;
  fetcher?: typeof fetch;
}

/**
 * Narrow implementation of the documented public platform-eVault APIs only:
 * Registry /entropy, Provisioner /provision, and eVault /graphql. It has no
 * browser surface and never sends a user session or eID credential upstream.
 */
export class RegistryPlatformEVaultClient implements W3dsPlatformEVaultRemoteClient {
  private readonly registryBaseUrl: string;
  private readonly provisionerBaseUrl: string;
  private readonly fetcher: typeof fetch;

  constructor(options: W3dsPlatformEVaultClientOptions) {
    this.registryBaseUrl = normalizeHttpUrl(options.registryBaseUrl, 'W3DS Registry URL');
    this.provisionerBaseUrl = normalizeHttpUrl(options.provisionerBaseUrl, 'W3DS Provisioner URL');
    this.fetcher = options.fetcher ?? fetch;
  }

  async provision(input: {
    verificationId: string;
  }): Promise<{ eName: string; eVaultUri: string }> {
    const entropy = await this.requestJson(new URL('/entropy', this.registryBaseUrl));
    if (!isRecord(entropy) || typeof entropy.token !== 'string' || !entropy.token) {
      throw new W3dsPlatformEVaultError(
        'Registry returned an invalid platform provisioning token.',
      );
    }

    const provisioned = await this.requestJson(new URL('/provision', this.provisionerBaseUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        registryEntropy: entropy.token,
        namespace: randomUUID(),
        verificationId: input.verificationId,
        // Platform eVaults are keyless by design. User eVault signing keys are
        // managed by the eID wallet and are never copied here.
      }),
    });
    if (
      !isRecord(provisioned) ||
      provisioned.success !== true ||
      typeof provisioned.w3id !== 'string' ||
      !isEName(provisioned.w3id) ||
      typeof provisioned.uri !== 'string'
    ) {
      throw new W3dsPlatformEVaultError(
        'Provisioner returned an invalid platform eVault response.',
      );
    }
    return {
      eName: provisioned.w3id,
      eVaultUri: normalizeHttpUrl(provisioned.uri, 'Provisioned eVault URL'),
    };
  }

  async writePlatformProfile(input: {
    eName: string;
    eVaultUri: string;
    profile: W3dsPlatformEVaultConfig['profile'];
    now: number;
  }): Promise<void> {
    const timestamp = new Date(input.now).toISOString();
    const response = await this.requestJson(new URL('/graphql', input.eVaultUri), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-ENAME': input.eName,
      },
      body: JSON.stringify({
        // `storeMetaEnvelope` is the documented unauthenticated bootstrap
        // mutation. Later profile updates require an official authenticated
        // W3DS client, rather than a guessed update request.
        query:
          'mutation StorePlatformProfile($input: MetaEnvelopeInput!) { storeMetaEnvelope(input: $input) { id } }',
        variables: {
          input: {
            ontology: w3dsPlatformProfileOntology,
            payload: {
              ...input.profile,
              ename: input.eName,
              isActive: true,
              isArchived: false,
              createdAt: timestamp,
              updatedAt: timestamp,
            },
            acl: ['*'],
          },
        },
      }),
    });
    if (isRecord(response) && Array.isArray(response.errors) && response.errors.length > 0) {
      throw new W3dsPlatformEVaultError('eVault rejected the platform discovery profile.');
    }
  }

  private async requestJson(url: URL, init?: RequestInit): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetcher(url, {
        cache: 'no-store',
        signal: AbortSignal.timeout(requestTimeoutMs),
        ...init,
      });
    } catch {
      throw new W3dsPlatformEVaultError('W3DS platform eVault infrastructure is unavailable.');
    }
    if (!response.ok) {
      throw new W3dsPlatformEVaultError(
        'W3DS platform eVault infrastructure rejected the request.',
      );
    }
    try {
      return (await response.json()) as unknown;
    } catch {
      throw new W3dsPlatformEVaultError(
        'W3DS platform eVault infrastructure returned invalid JSON.',
      );
    }
  }
}

export interface W3dsPlatformEVaultBootstrapOptions {
  registryBaseUrl: string;
  platformEVault: W3dsPlatformEVaultConfig;
  store?: W3dsPlatformEVaultStore;
  remoteClient?: W3dsPlatformEVaultRemoteClient;
  now?: () => number;
}

/**
 * Ensures Vidak has exactly one locally mapped platform eVault. The local
 * record is checked before any remote request, making normal server restarts
 * idempotent and avoiding accidental re-provisioning.
 */
export async function ensureW3dsPlatformEVault(
  options: W3dsPlatformEVaultBootstrapOptions,
): Promise<W3dsPlatformEVaultRecord> {
  const store = options.store ?? new PostgresW3dsPlatformEVaultStore(getW3dsDatabase());
  const existing = await store.get();
  if (existing) return existing;

  const remoteClient =
    options.remoteClient ??
    new RegistryPlatformEVaultClient({
      registryBaseUrl: options.registryBaseUrl,
      provisionerBaseUrl: options.platformEVault.provisionerBaseUrl,
    });
  const provisioned = await remoteClient.provision({
    verificationId: options.platformEVault.verificationId,
  });
  const now = (options.now ?? Date.now)();
  await remoteClient.writePlatformProfile({
    eName: provisioned.eName,
    eVaultUri: provisioned.eVaultUri,
    profile: options.platformEVault.profile,
    now,
  });
  return store.createIfAbsent({
    eName: provisioned.eName,
    eVaultUri: provisioned.eVaultUri,
    profile: options.platformEVault.profile,
    now,
  });
}

function recordFromRow(row: typeof w3dsPlatformEVault.$inferSelect): W3dsPlatformEVaultRecord {
  return {
    id: row.id,
    eName: row.eName,
    eVaultUri: row.eVaultUri,
    profile: {
      platformName: row.platformName,
      displayName: row.displayName,
      description: row.description,
      version: row.profileVersion,
      url: row.publicUrl,
      logoUrl: row.logoUrl,
      category: row.category,
    },
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

function cloneRecord(record: W3dsPlatformEVaultRecord): W3dsPlatformEVaultRecord {
  return { ...record, profile: { ...record.profile } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isEName(value: string): boolean {
  return /^@[a-z0-9][a-z0-9.-]*$/i.test(value);
}

function normalizeHttpUrl(value: string, label: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('protocol');
    return url.toString();
  } catch {
    throw new W3dsPlatformEVaultError(`${label} must be an HTTP(S) URL.`);
  }
}
