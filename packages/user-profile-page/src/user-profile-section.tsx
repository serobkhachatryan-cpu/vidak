import { Button, ErrorState } from '@w3ds/ui';
import { type ReactNode, useEffect, useRef } from 'react';

export type UserProfileSectionState = 'ready' | 'loading' | 'empty' | 'error';

const sectionErrorDescription = 'Please check your connection and try again.';

export const skeletonKeys = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, index) => `${prefix}-${index}`);

/**
 * Announces a single message per loading section: the skeletons inside carry
 * their own status roles, which would otherwise be announced one by one.
 */
export function LoadingRegion({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div role="status" aria-live="polite" aria-label={label}>
      <div aria-hidden="true">{children}</div>
    </div>
  );
}

export interface UserProfileSectionProps {
  state: UserProfileSectionState;
  isEmpty: boolean;
  loading: ReactNode;
  empty: ReactNode;
  errorTitle: string;
  onRetry?: (() => void) | undefined;
  children: ReactNode;
}

export function UserProfileSection({
  state,
  isEmpty,
  loading,
  empty,
  errorTitle,
  onRetry,
  children,
}: UserProfileSectionProps) {
  if (state === 'loading') return <>{loading}</>;
  if (state === 'error') {
    return (
      <ErrorState
        title={errorTitle}
        description={sectionErrorDescription}
        {...(onRetry ? { retry: onRetry } : {})}
      />
    );
  }
  if (state === 'empty' || isEmpty) return <>{empty}</>;
  return <>{children}</>;
}

export function LoadMoreVideos({
  onLoadMore,
  hasMore = false,
  isFetchingMore = false,
}: {
  onLoadMore?: (() => void) | undefined;
  hasMore?: boolean | undefined;
  isFetchingMore?: boolean | undefined;
}) {
  const sentinelRef = useRef<HTMLDivElement>(null);
  const onLoadMoreRef = useRef(onLoadMore);
  const canLoadMore = Boolean(onLoadMore) && hasMore && !isFetchingMore;

  useEffect(() => {
    onLoadMoreRef.current = onLoadMore;
  }, [onLoadMore]);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !canLoadMore) return;
    if (!('IntersectionObserver' in window)) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) onLoadMoreRef.current?.();
      },
      { rootMargin: '240px' },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [canLoadMore]);

  if (!hasMore && !isFetchingMore) return null;
  return (
    <div ref={sentinelRef} className="mt-6 flex justify-center" aria-live="polite">
      <Button variant="secondary" size="sm" onClick={onLoadMore} isLoading={isFetchingMore}>
        Load more videos
      </Button>
    </div>
  );
}
