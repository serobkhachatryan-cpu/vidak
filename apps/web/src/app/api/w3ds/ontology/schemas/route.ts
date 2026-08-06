import { NextResponse } from 'next/server';
import {
  listVidakPrivateOntologySchemas,
  VIDAK_PRIVATE_ONTOLOGY_JSON_HEADERS,
} from '../../../../../server/w3ds-private-ontology';

export const runtime = 'nodejs';

/**
 * GET /api/w3ds/ontology/schemas
 *
 * Public, read-only listing of Vidak's private Ontology catalogue.
 * Compatible with W3DS Ontology GET /schemas shape (id + title per entry),
 * with explicit private / Vidak-owned labels. Not MetaState Ontology.
 */
export async function GET() {
  const body = listVidakPrivateOntologySchemas();
  return NextResponse.json(body, {
    status: 200,
    headers: { ...VIDAK_PRIVATE_ONTOLOGY_JSON_HEADERS },
  });
}
