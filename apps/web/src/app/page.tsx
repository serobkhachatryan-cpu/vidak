import { Suspense } from 'react';
import { SessionLoadingSkeleton } from '../features/auth/auth-provider';
import { HomeFeed } from '../features/home/home-feed';

export default function Page() {
  return (
    <Suspense fallback={<SessionLoadingSkeleton />}>
      <HomeFeed />
    </Suspense>
  );
}
