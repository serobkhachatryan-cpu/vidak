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
  /** Present when more pages remain so a background scan can continue. */
  endCursor?: string;
}

export function readEnvelopeConnectionPage(connection: Record<string, unknown> | undefined): {
  edges: unknown[];
  hasNextPage: boolean | undefined;
  endCursor?: string;
} {
  const pageInfo =
    connection?.pageInfo &&
    typeof connection.pageInfo === 'object' &&
    !Array.isArray(connection.pageInfo)
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
  after?: string | null;
  readPage: (
    after: string | null,
  ) => Promise<Record<string, unknown> | EnvelopeConnectionPage | undefined>;
  mapEdge: (edge: unknown) => T | undefined;
  onPage?: (pageItems: T[], meta: { pageIndex: number; hasMore: boolean }) => void | Promise<void>;
}): Promise<PaginatedEnvelopes<T>> {
  const items: T[] = [];
  let after: string | null = input.after ?? null;
  let lastCursor: string | undefined;
  for (let page = 0; page < input.maxPages; page += 1) {
    const pageData = readEnvelopeConnectionPage(record(await input.readPage(after)));
    const pageItems: T[] = [];
    for (const edge of pageData.edges) {
      const item = input.mapEdge(edge);
      if (item) {
        items.push(item);
        pageItems.push(item);
      }
    }
    lastCursor = pageData.endCursor;
    await input.onPage?.(pageItems, { pageIndex: page, hasMore: pageData.hasNextPage === true });
    if (pageData.hasNextPage === false) return { items, complete: true };
    if (pageData.hasNextPage === true) {
      if (!pageData.endCursor) return { items, complete: false };
      after = pageData.endCursor;
      continue;
    }
    // Documented pageInfo includes hasNextPage; some eVaults omit false on the
    // only page. A missing flag with no cursor is a finished page, not a drop.
    if (!pageData.endCursor) return { items, complete: true };
    return { items, complete: false, endCursor: pageData.endCursor };
  }
  return {
    items,
    complete: false,
    ...(hasMoreCursor(lastCursor) ? { endCursor: lastCursor } : {}),
  };
}

function hasMoreCursor(cursor: string | undefined): cursor is string {
  return Boolean(cursor);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
