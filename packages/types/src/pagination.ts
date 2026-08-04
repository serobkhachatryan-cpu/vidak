export interface PaginationParams {
  cursor?: string;
  limit?: number;
}

export interface CursorPage<T> {
  items: readonly T[];
  nextCursor?: string;
}
