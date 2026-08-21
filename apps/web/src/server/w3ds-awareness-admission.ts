/// <reference path="./server-only-module.d.ts" />
/**
 * Server-only schema admission for authenticated Awareness packets.
 *
 * The AaaS webhook is broadcast-oriented: packets for schemas Vidak has not
 * explicitly configured must be acknowledged as ignored. This module only
 * classifies an already-authenticated packet; it never projects fields into a
 * product row or mapping, or constructs an eVault client.
 */

import 'server-only';
import {
  loadServerSecurityConfig,
  type W3dsOntologyAdapterConfig,
  type W3dsOntologyMode,
} from './server-config';
import { loadOfficialMappingRules, type W3dsMappingRulesDocument } from './w3ds-mapping-rules';

export interface W3dsAwarenessEnvelope {
  id: string;
  w3id: string;
  schemaId: string;
  data: Record<string, unknown>;
}

export type W3dsAwarenessAdmission =
  | { status: 'eligible'; mapping: W3dsMappingRulesDocument; mappingVersion: number }
  | { status: 'ignored' };

/**
 * Matches a packet only against explicitly configured official Mapping Rules.
 * Configuration errors, private mode, and unknown schemas all fail closed as
 * ignored so broadcast traffic cannot create a retry storm or product data.
 */
export function admitW3dsAwarenessEnvelope(input: {
  envelope: W3dsAwarenessEnvelope;
  ontologyMode: W3dsOntologyMode;
  ontologyAdapter: W3dsOntologyAdapterConfig | null;
  mappingDocuments?: readonly unknown[];
}): W3dsAwarenessAdmission {
  if (input.ontologyMode !== 'metastate_official' || !input.ontologyAdapter) {
    return { status: 'ignored' };
  }

  try {
    const loaded = loadOfficialMappingRules({
      ontologyMode: input.ontologyMode,
      ontologyAdapter: input.ontologyAdapter,
      ...(input.mappingDocuments ? { documents: input.mappingDocuments } : {}),
    });
    const mapping = loaded.documents.find(
      (document) => document.schemaId === input.envelope.schemaId,
    );
    // Channel is the sole product projection implemented so far. Every other
    // configured schema is acknowledged as ignored until it has an equally
    // transactional, product-specific inbound projection. This avoids partial
    // Video/media or reserved-table writes from an authenticated broadcast.
    return mapping?.entityType === 'channel'
      ? { status: 'eligible', mapping, mappingVersion: input.ontologyAdapter.mappingVersion }
      : { status: 'ignored' };
  } catch {
    return { status: 'ignored' };
  }
}

/**
 * Production resolver. Called by the webhook handler only after raw-body HMAC
 * verification and envelope parsing; it does not allocate a database client.
 */
export function resolveW3dsAwarenessAdmission(
  envelope: W3dsAwarenessEnvelope,
): W3dsAwarenessAdmission {
  try {
    const config = loadServerSecurityConfig();
    return admitW3dsAwarenessEnvelope({
      envelope,
      ontologyMode: config.ontologyMode,
      ontologyAdapter: config.w3ds?.ontologyAdapter ?? null,
    });
  } catch {
    return { status: 'ignored' };
  }
}
