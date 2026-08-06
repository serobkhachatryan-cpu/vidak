import { type NextRequest, NextResponse } from 'next/server';
import {
  getVidakPrivateOntologySchema,
  VIDAK_PRIVATE_ONTOLOGY_JSON_HEADERS,
} from '../../../../../../server/w3ds-private-ontology';

export const runtime = 'nodejs';

type RouteContext = {
  params: Promise<{ schemaId: string }>;
};

/**
 * GET /api/w3ds/ontology/schemas/[schemaId]
 *
 * Public, read-only fetch of one Vidak private draft-07 schema by stable
 * Vidak-owned schemaId. Returns 404 for unknown IDs. No register/write API.
 */
export async function GET(_request: NextRequest, context: RouteContext) {
  const { schemaId } = await context.params;
  const result = getVidakPrivateOntologySchema(schemaId);

  if (!result.ok) {
    return NextResponse.json(result.body, {
      status: result.status,
      headers: {
        ...VIDAK_PRIVATE_ONTOLOGY_JSON_HEADERS,
        'Cache-Control': 'no-store',
      },
    });
  }

  return NextResponse.json(result.schema, {
    status: 200,
    headers: { ...VIDAK_PRIVATE_ONTOLOGY_JSON_HEADERS },
  });
}
