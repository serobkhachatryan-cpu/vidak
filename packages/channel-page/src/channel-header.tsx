import type { Channel } from '@w3ds/types';
import { Avatar, Badge, Button, Heading, Text } from '@w3ds/ui';
import { formatSubscribers, formatVideoCount } from './format';
import { cx } from './styles';

export const channelBannerClassName = 'h-28 w-full rounded-xl sm:h-40 lg:h-56';

function ChannelBanner({ channel }: { channel: Channel }) {
  return channel.bannerUrl ? (
    <img
      src={channel.bannerUrl}
      alt={`${channel.name} channel banner`}
      className={cx(channelBannerClassName, 'object-cover')}
    />
  ) : (
    <div
      role="img"
      aria-label={`${channel.name} channel banner`}
      className={cx(
        channelBannerClassName,
        'bg-gradient-to-r from-primary/40 via-primary/15 to-surface-raised',
      )}
    />
  );
}

function SubscribeButton({
  subscribed,
  onToggle,
  channelName,
}: {
  subscribed: boolean;
  onToggle: () => void;
  channelName: string;
}) {
  return (
    <Button
      variant={subscribed ? 'secondary' : 'primary'}
      onClick={onToggle}
      aria-pressed={subscribed}
      aria-label={`${subscribed ? 'Unsubscribe from' : 'Subscribe to'} ${channelName}`}
      className="shrink-0"
    >
      {subscribed ? 'Subscribed' : 'Subscribe'}
    </Button>
  );
}

export function ChannelHeader({
  channel,
  isVerified,
  subscriberCount,
  subscribed,
  onSubscribeToggle,
}: {
  channel: Channel;
  isVerified: boolean;
  subscriberCount: number;
  subscribed: boolean;
  onSubscribeToggle: () => void;
}) {
  const summary = [
    `@${channel.handle}`,
    formatSubscribers(subscriberCount),
    formatVideoCount(channel.videoCount),
  ].join(' · ');

  return (
    <header className="space-y-4">
      <ChannelBanner channel={channel} />
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 flex-col gap-4 sm:flex-row sm:items-center">
          <Avatar
            {...(channel.avatarUrl ? { src: channel.avatarUrl } : {})}
            alt=""
            name={channel.name}
            size="xl"
            className="sm:h-28 sm:w-28 sm:text-2xl"
          />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Heading as="h1" size="xl">
                {channel.name}
              </Heading>
              {isVerified && (
                <Badge tone="muted" aria-label="Verified channel">
                  <span aria-hidden="true" className="mr-1">
                    ✓
                  </span>
                  Verified
                </Badge>
              )}
            </div>
            <Text size="sm" tone="muted" className="mt-1">
              {summary}
            </Text>
            {channel.description && (
              <Text size="sm" tone="muted" className="mt-2 line-clamp-2 max-w-2xl">
                {channel.description}
              </Text>
            )}
          </div>
        </div>
        <SubscribeButton
          subscribed={subscribed}
          onToggle={onSubscribeToggle}
          channelName={channel.name}
        />
      </div>
    </header>
  );
}
