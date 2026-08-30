import { LibraryWatchPage } from '../../../../features/watch/library-watch-page';

type WatchSpacePageProps = { params: Promise<{ itemId: string }> };

export default async function Page({ params }: WatchSpacePageProps) {
  const { itemId } = await params;
  return <LibraryWatchPage itemId={decodeURIComponent(itemId)} />;
}
