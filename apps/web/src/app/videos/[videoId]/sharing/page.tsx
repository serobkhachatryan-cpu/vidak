import { VideoSharingSettingsPage } from '../../../../features/sharing/video-sharing-settings-page';

type PageProps = { params: Promise<{ videoId: string }> };

export default async function Page({ params }: PageProps) {
  const { videoId } = await params;
  return <VideoSharingSettingsPage key={videoId} videoId={videoId} />;
}
