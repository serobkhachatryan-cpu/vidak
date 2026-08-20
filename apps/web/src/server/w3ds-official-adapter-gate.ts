/**
 * Fail-closed gate for official (MetaState) Web3 Adapter eVault writes.
 *
 * Mapping Rules and configured schemaIds do not authorize HTTP eVault clients.
 * P1A never constructs the platform eVault HTTP client for official adapter sync
 * and never reports remote W3DS success. Platform eVault bootstrap remains a
 * separate opt-in path.
 */

import type { W3dsOntologyAdapterConfig, W3dsOntologyMode } from './server-config';
import { assertAllowedOfficialSchemaIds, W3dsSchemaIdPolicyError } from './w3ds-schema-id-policy';

/**
 * Exact gaps that block official MetaEnvelope HTTP calls in this repository.
 * Kept as stable strings for diagnostics and fail-closed errors.
 */
export const W3DS_OFFICIAL_EVAULT_CLIENT_GAPS = [
  'Official W3DS eVault MetaEnvelope client is not installed. Mapping Rules and Ontology schema IDs do not authorize createMetaEnvelope, updateMetaEnvelope, or removeMetaEnvelope writes.',
  'POST /platforms/certification is mentioned by the Web3 Adapter docs without a documented request body in the local reference. Fabricating a platform-certification or owner-eVault HTTP client is not permitted.',
  'Official adapter HTTP eVault construction therefore stays unavailable until an official client surface and MetaState-assigned schema IDs are both present.',
] as const;

export class W3dsOfficialAdapterGateError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'mode_unavailable'
      | 'adapter_unconfigured'
      | 'schema_id_rejected'
      | 'http_evault_client_unavailable',
  ) {
    super(message);
    this.name = 'W3dsOfficialAdapterGateError';
  }
}

export interface W3dsOfficialAdapterGateInput {
  ontologyMode: W3dsOntologyMode;
  ontologyAdapter: W3dsOntologyAdapterConfig | null;
}

export type W3dsOfficialEVaultClientResolution = {
  status: 'unavailable';
  missing: readonly string[];
};

/** Official MetaEnvelope eVault client is not installed. */
export function resolveW3dsOfficialEVaultClient(): W3dsOfficialEVaultClientResolution {
  return { status: 'unavailable', missing: W3DS_OFFICIAL_EVAULT_CLIENT_GAPS };
}

export interface W3dsOfficialAdapterWriteGate {
  allowed: false;
  officialEVaultWrites: false;
  metastateEVaultWrites: false;
  remoteW3dsNetworkCalls: false;
  interoperablePublicW3ds: false;
  httpEvaultClientConstructed: false;
  officialEvaultClient: 'unavailable';
  missing: readonly string[];
  reason: string;
  code: W3dsOfficialAdapterGateError['code'];
}

const remoteSuccessDenied = {
  allowed: false,
  officialEVaultWrites: false,
  metastateEVaultWrites: false,
  remoteW3dsNetworkCalls: false,
  interoperablePublicW3ds: false,
  httpEvaultClientConstructed: false,
  officialEvaultClient: 'unavailable',
} as const;

export function resolveW3dsOfficialAdapterWriteGate(
  input: W3dsOfficialAdapterGateInput,
): W3dsOfficialAdapterWriteGate {
  const client = resolveW3dsOfficialEVaultClient();

  if (input.ontologyMode !== 'metastate_official') {
    return {
      ...remoteSuccessDenied,
      missing: client.missing,
      code: 'mode_unavailable',
      reason:
        'Official eVault writes require W3DS_ONTOLOGY_MODE=metastate_official. vidak_private adapter enablement must not construct an official HTTP eVault client.',
    };
  }

  if (!input.ontologyAdapter) {
    return {
      ...remoteSuccessDenied,
      missing: client.missing,
      code: 'adapter_unconfigured',
      reason:
        'Official eVault writes require W3DS_ONTOLOGY_ADAPTER_ENABLED=true and every W3DS_ONTOLOGY_SCHEMA_ID_*. Schema IDs must not be guessed.',
    };
  }

  try {
    assertAllowedOfficialSchemaIds(input.ontologyAdapter.schemaIds);
  } catch (error) {
    const message =
      error instanceof W3dsSchemaIdPolicyError
        ? error.message
        : 'Official adapter schema IDs are invalid.';
    return {
      ...remoteSuccessDenied,
      missing: client.missing,
      code: 'schema_id_rejected',
      reason: message,
    };
  }

  return {
    ...remoteSuccessDenied,
    missing: client.missing,
    code: 'http_evault_client_unavailable',
    reason: `W3DS official eVault client is unavailable: ${client.missing.join(' ')}`,
  };
}

/**
 * Official adapter HTTP eVault construction. Always throws in P1A.
 * Does not import or instantiate the platform eVault HTTP client.
 */
export function createW3dsOfficialHttpEvaultClient(input: W3dsOfficialAdapterGateInput): never {
  const gate = resolveW3dsOfficialAdapterWriteGate(input);
  throw new W3dsOfficialAdapterGateError(gate.reason, gate.code);
}

export function requireW3dsOfficialEVaultClient(): never {
  const resolved = resolveW3dsOfficialEVaultClient();
  throw new W3dsOfficialAdapterGateError(
    `W3DS official eVault client is unavailable: ${resolved.missing.join(' ')}`,
    'http_evault_client_unavailable',
  );
}
