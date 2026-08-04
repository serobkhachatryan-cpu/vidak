import { ChannelPageFeature } from '../../../features/channel/channel-page';

export default async function Page({ params }: { params: Promise<{ channelId: string }> }) {
  const { channelId } = await params;
  return <ChannelPageFeature channelId={channelId} />;
}
