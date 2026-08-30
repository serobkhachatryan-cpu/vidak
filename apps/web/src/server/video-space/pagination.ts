/**
 * Exhaustive cursor pagination over documented eVault `metaEnvelopes` pages.
 * A missing or truncated page is incomplete, never silently treated as the full list.
 */
export interface EnvelopeConnectionPage {
  edges: unknown;
  pageInfo: unknown;
}

export interface PaginatedEnvelopes<T> {
  items: T[];
  complete: boolean;
}

export function readEnvelopeConnectionPage(connection: Record<string, unknown> | undefined): {
  edges: unknown[];
  hasNextPage: boolean | undefined;
  endCursor?: string;
} {
  const pageInfo =
    connection?.pageInfo && typeof connection.pageInfo === 'object' && !Array.isArray(connection.pageInfo)
      ? (connection.pageInfo as Record<string, unknown>)
      : undefined;
  const hasNextPage = pageInfo?.hasNextPage;
  const endCursor =
    typeof pageInfo?.endCursor === 'string' && pageInfo.endCursor.trim()
      ? pageInfo.endCursor.trim()
      : undefined;
  return {
    edges: Array.isArray(connection?.edges) ? connection.edges : [],
    hasNextPage: typeof hasNextPage === 'boolean' ? hasNextPage : undefined,
    ...(endCursor ? { endCursor } : {}),
  };
}

export async function collectPaginatedEnvelopes<T>(input: {
  maxPages: number;
  readPage: (after: string | null) => Promise<Record<string, unknown> | EnvelopeConnectionPage | undefined>;
  mapEdge: (edge: unknown) => T | undefined;
}): Promise<PaginatedEnvelopes<T>> {
  const items: T[] = [];
  let after: string | null = null;
  for (let page = 0; page < input.maxPages; page += 1) {
    const pageData = readEnvelopeConnectionPage(
      record(await input.readPage(after)),
    );
    for (const edge of pageData.edges) {
      const item = input.mapEdge(edge);
      if (item) items.push(item);
    }
    if (pageData.hasNextPage === false) return { items, complete: true };
    if (pageData.hasNextPage !== true) return { items, complete: false };
    if (!pageData.endCursor) return { items, complete: false };
    after = pageData.endCursor;
  }
  return { items, complete: false };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
