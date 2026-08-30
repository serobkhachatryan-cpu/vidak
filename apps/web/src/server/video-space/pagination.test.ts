import { describe, expect, it } from 'vitest';
import { collectPaginatedEnvelopes } from './pagination';

describe('envelope pagination', () => {
  it('follows every page instead of treating the first page as complete', async () => {
    const pages = [
      {
        edges: [{ node: { id: 'one' } }],
        pageInfo: { hasNextPage: true, endCursor: 'cursor-1' },
      },
      {
        edges: [{ node: { id: 'two' } }],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    ];
    let calls = 0;
    const result = await collectPaginatedEnvelopes({
      maxPages: 30,
      readPage: async () => pages[calls++],
      mapEdge: (edge) => {
        const node = (edge as { node?: { id?: string } }).node;
        return node?.id;
      },
    });
    expect(result).toEqual({ items: ['one', 'two'], complete: true });
    expect(calls).toBe(2);
  });

  it('marks a truncated page as incomplete instead of pretending the list is finished', async () => {
    const result = await collectPaginatedEnvelopes({
      maxPages: 1,
      readPage: async () => ({
        edges: [{ node: { id: 'one' } }],
        pageInfo: { hasNextPage: true, endCursor: 'cursor-1' },
      }),
      mapEdge: (edge) => (edge as { node?: { id?: string } }).node?.id,
    });
    expect(result.items).toEqual(['one']);
    expect(result.complete).toBe(false);
  });
});
