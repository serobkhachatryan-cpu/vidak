import { SharedVideoWatchPage } from '../../../../features/watch/shared-video-watch-page';

type PageProps = { params: Promise<{ shareToken: string }> };

export default async function Page({ params }: PageProps) {
  const { shareToken } = await params;
  return <SharedVideoWatchPage shareToken={shareToken} />;
}
