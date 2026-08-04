import { WatchPageFeature } from '../../../features/watch/watch-page';

export default async function Page({ params }: { params: Promise<{ videoId: string }> }) {
  const { videoId } = await params;
  return <WatchPageFeature videoId={videoId} />;
}
