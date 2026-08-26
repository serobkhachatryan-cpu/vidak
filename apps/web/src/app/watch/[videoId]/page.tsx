import { WatchPageFeature } from '../../../features/watch/watch-page';
import { generateWatchPageMetadata } from './watch-page-metadata';

type WatchPageProps = { params: Promise<{ videoId: string }> };

export async function generateMetadata({ params }: WatchPageProps) {
  const { videoId } = await params;
  return generateWatchPageMetadata(videoId);
}

export default async function Page({ params }: WatchPageProps) {
  const { videoId } = await params;
  return <WatchPageFeature videoId={videoId} />;
}
