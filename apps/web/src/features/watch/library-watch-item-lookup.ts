/** Exact, same-origin watch lookup; URLSearchParams preserves opaque item IDs. */
export function libraryWatchItemLookupPath(itemId: string): string {
  const query = new URLSearchParams({ scope: 'all', itemId });
  return `/api/evault/videos?${query.toString()}`;
}
