/**
 * Official owner-eVault MetaEnvelope client boundary.
 *
 * Production resolve stays unavailable (P1A gate). Tests may inject
 * FakeW3dsOfficialEVaultClient; resolveW3dsOfficialEVaultClient never returns it.
 * Method names follow evault.md: createMetaEnvelope, updateMetaEnvelope,
 * removeMetaEnvelope. Registry resolution is GET /resolve — this module does
 * not invent POST /platforms/certification.
 */

import {
  resolveW3dsOfficialEVaultClient as resolveOfficialClientFromGate,
  W3DS_OFFICIAL_EVAULT_CLIENT_GAPS,
  W3dsOfficialAdapterGateError,
} from './w3ds-official-adapter-gate';

export { W3DS_OFFICIAL_EVAULT_CLIENT_GAPS, W3dsOfficialAdapterGateError };

const eNamePattern = /^@[^\s@]+$/;

export interface W3dsOfficialMetaEnvelopeWriteInput {
  ownerEName: string;
  schemaId: string;
  payload: Record<string, unknown>;
}

export interface W3dsOfficialMetaEnvelopeCreateResult {
  id: string;
}

export interface W3dsOfficialMetaEnvelopeUpdateResult {
  id: string;
}

export interface W3dsOfficialMetaEnvelopeRemoveResult {
  deletedId: string;
  success: boolean;
}

/**
 * Server-only official eVault operations used by handleChange.
 * Implementations must send X-ENAME on real HTTP; the Fake never performs HTTP.
 */
export interface W3dsOfficialEVaultClient {
  readonly source: string;
  resolveEvaultUri(eName: string): Promise<string>;
  createMetaEnvelope(
    input: W3dsOfficialMetaEnvelopeWriteInput,
  ): Promise<W3dsOfficialMetaEnvelopeCreateResult>;
  updateMetaEnvelope(
    input: W3dsOfficialMetaEnvelopeWriteInput & { id: string },
  ): Promise<W3dsOfficialMetaEnvelopeUpdateResult>;
  removeMetaEnvelope(input: {
    ownerEName: string;
    id: string;
  }): Promise<W3dsOfficialMetaEnvelopeRemoveResult>;
}

export type W3dsOfficialEVaultClientResolution =
  | { status: 'available'; client: W3dsOfficialEVaultClient }
  | { status: 'unavailable'; missing: readonly string[] };

export function resolveW3dsOfficialEVaultClient(): W3dsOfficialEVaultClientResolution {
  return resolveOfficialClientFromGate();
}

export function requireW3dsOfficialEVaultClient(): W3dsOfficialEVaultClient {
  const resolved = resolveW3dsOfficialEVaultClient();
  if (resolved.status === 'available') {
    return resolved.client;
  }
  throw new W3dsOfficialAdapterGateError(
    `W3DS official eVault client is unavailable: ${resolved.missing.join(' ')}`,
    'http_evault_client_unavailable',
  );
}

/** Injected loopback sandbox sources. Production resolve never returns these. */
export const W3DS_OFFICIAL_SANDBOX_CLIENT_SOURCES = [
  'sandbox://127.0.0.1',
  'sandbox://localhost',
] as const;

/**
 * Classifies injected test sources. Not authentication and not a write grant.
 * Production resolveW3dsOfficialEVaultClient never selects these.
 */
export function isSandboxInjectedOfficialEVaultClientSource(source: string): boolean {
  return (W3DS_OFFICIAL_SANDBOX_CLIENT_SOURCES as readonly string[]).includes(source);
}

export function isAllowedInjectedOfficialEVaultClientSource(source: string): boolean {
  return source.startsWith('fake://') || isSandboxInjectedOfficialEVaultClientSource(source);
}

function assertEName(eName: string, method: string): string {
  const trimmed = eName.trim();
  if (!eNamePattern.test(trimmed)) {
    throw new Error(`${method} requires a valid owner eName (e.g. @user.w3id).`);
  }
  return trimmed;
}

/**
 * In-memory Fake of the official MetaEnvelope client for unit tests.
 * Not a production fallback and never selected by resolveW3dsOfficialEVaultClient.
 */
export class FakeW3dsOfficialEVaultClient implements W3dsOfficialEVaultClient {
  readonly source = 'fake://w3ds-official-evault-client';
  readonly envelopes = new Map<
    string,
    { ownerEName: string; schemaId: string; payload: Record<string, unknown> }
  >();
  readonly calls: Array<{ method: string; input: unknown }> = [];
  /** When set, the next createMetaEnvelope uses this id once. */
  nextCreateId: string | undefined;
  private createSeq = 0;
  private nextFailure: { method: string; message: string } | undefined;

  failNext(
    method: 'resolveEvaultUri' | 'createMetaEnvelope' | 'updateMetaEnvelope' | 'removeMetaEnvelope',
    message: string,
  ): void {
    this.nextFailure = { method, message };
  }

  async resolveEvaultUri(eName: string): Promise<string> {
    const ownerEName = assertEName(eName, 'resolveEvaultUri');
    this.record('resolveEvaultUri', { eName: ownerEName });
    this.throwIfFailed('resolveEvaultUri');
    return `fake://evault/${ownerEName}`;
  }

  async createMetaEnvelope(
    input: W3dsOfficialMetaEnvelopeWriteInput,
  ): Promise<W3dsOfficialMetaEnvelopeCreateResult> {
    const ownerEName = assertEName(input.ownerEName, 'createMetaEnvelope');
    this.record('createMetaEnvelope', { ...input, ownerEName });
    this.throwIfFailed('createMetaEnvelope');
    const id = this.nextCreateId ?? `me_fake_${++this.createSeq}`;
    this.nextCreateId = undefined;
    this.envelopes.set(id, {
      ownerEName,
      schemaId: input.schemaId,
      payload: { ...input.payload },
    });
    return { id };
  }

  async updateMetaEnvelope(
    input: W3dsOfficialMetaEnvelopeWriteInput & { id: string },
  ): Promise<W3dsOfficialMetaEnvelopeUpdateResult> {
    const ownerEName = assertEName(input.ownerEName, 'updateMetaEnvelope');
    this.record('updateMetaEnvelope', { ...input, ownerEName });
    this.throwIfFailed('updateMetaEnvelope');
    const existing = this.envelopes.get(input.id);
    if (!existing) {
      throw new Error(`Fake official eVault has no MetaEnvelope ${input.id}.`);
    }
    if (existing.ownerEName !== ownerEName) {
      throw new Error(`Fake official eVault refuses owner change for ${input.id}.`);
    }
    this.envelopes.set(input.id, {
      ownerEName,
      schemaId: input.schemaId,
      payload: { ...input.payload },
    });
    return { id: input.id };
  }

  async removeMetaEnvelope(input: {
    ownerEName: string;
    id: string;
  }): Promise<W3dsOfficialMetaEnvelopeRemoveResult> {
    const ownerEName = assertEName(input.ownerEName, 'removeMetaEnvelope');
    this.record('removeMetaEnvelope', { ...input, ownerEName });
    this.throwIfFailed('removeMetaEnvelope');
    const existing = this.envelopes.get(input.id);
    if (!existing || existing.ownerEName !== ownerEName) {
      return { deletedId: input.id, success: false };
    }
    this.envelopes.delete(input.id);
    return { deletedId: input.id, success: true };
  }

  private record(method: string, input: unknown): void {
    this.calls.push({ method, input });
  }

  private throwIfFailed(method: string): void {
    if (this.nextFailure?.method === method) {
      const message = this.nextFailure.message;
      this.nextFailure = undefined;
      throw new Error(message);
    }
  }
}
