import type { CursorPage, PaginationParams } from '@w3ds/types';

const DEFAULT_PAGE_SIZE = 20;

export function createCursorPage<T>(
  items: readonly T[],
  params: PaginationParams = {},
): CursorPage<T> {
  const offset = parseCursor(params.cursor);
  const limit = params.limit ?? DEFAULT_PAGE_SIZE;
  const pageItems = items.slice(offset, offset + limit);
  const nextOffset = offset + pageItems.length;

  return {
    items: pageItems,
    ...(nextOffset < items.length ? { nextCursor: `offset:${nextOffset}` } : {}),
  };
}

function parseCursor(cursor: string | undefined): number {
  if (!cursor) {
    return 0;
  }

  const match = /^offset:(\d+)$/.exec(cursor);
  return match ? Number(match[1]) : 0;
}

export function getNextPageParam<T>(page: CursorPage<T>): string | undefined {
  return page.nextCursor;
}
