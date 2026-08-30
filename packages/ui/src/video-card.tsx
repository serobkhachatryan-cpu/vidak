'use client';

import type { Channel, Video } from '@w3ds/types';
import { isRenderableThumbnailUrl, SOURCE_NEUTRAL_CHANNEL_LABEL } from '@w3ds/types';
import { useState } from 'react';
import { Avatar, Badge, Skeleton } from './primitives';
import { cx, focusRing } from './utils';

function formatDuration(durationSeconds: number): string {
  const hours = Math.floor(durationSeconds / 3600);
  const minutes = Math.floor((durationSeconds % 3600) / 60);
  const seconds = durationSeconds % 60;

  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function formatViews(viewCount: number): string {
  return `${new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(viewCount)} views`;
}

function formatPublishedAt(publishedAt?: string): string | undefined {
  if (!publishedAt) return undefined;
  const days = Math.max(0, Math.floor((Date.now() - new Date(publishedAt).getTime()) / 86_400_000));
  if (days < 1) return 'Today';
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} month${months === 1 ? '' : 's'} ago`;
  const years = Math.floor(months / 12);
  return `${years} year${years === 1 ? '' : 's'} ago`;
}

function VideoThumbnail({ src, title }: { src: string; title: string }) {
  const [failed, setFailed] = useState(false);
  const safe = isRenderableThumbnailUrl(src);

  if (!safe || failed) {
    return (
      <div
        className="aspect-video w-full bg-muted"
        role="img"
        aria-label={`${title} thumbnail unavailable`}
      />
    );
  }

  return (
    <img
      src={src.trim()}
      alt=""
      loading="lazy"
      className="aspect-video w-full object-cover transition-transform duration-normal group-hover:scale-[1.03]"
      onError={() => setFailed(true)}
    />
  );
}

export interface VideoCardProps {
  video: Video;
  channel?: Pick<Channel, 'name' | 'handle' | 'avatarUrl'> & { id?: string };
  href?: string;
  channelHref?: string;
  className?: string;
}

export function VideoCard({
  video,
  channel,
  href = `/watch/${video.publicVideoId ?? video.id}`,
  channelHref,
  className,
}: VideoCardProps) {
  const metadata = [formatViews(video.viewCount), formatPublishedAt(video.publishedAt)]
    .filter(Boolean)
    .join(' · ');
  const resolvedChannel = channel ?? video.channel;
  const hasRealChannel = Boolean(resolvedChannel?.id && resolvedChannel.name);
  const channelName = hasRealChannel
    ? (resolvedChannel?.name ?? SOURCE_NEUTRAL_CHANNEL_LABEL)
    : SOURCE_NEUTRAL_CHANNEL_LABEL;
  const resolvedChannelHref = hasRealChannel
    ? (channelHref ?? `/channel/${resolvedChannel?.id ?? video.channelId}`)
    : undefined;

  return (
    <article className={cx('group min-w-0', className)}>
      <a
        href={href}
        aria-label={`Watch ${video.title}`}
        className={cx('relative block overflow-hidden rounded-lg bg-muted', focusRing)}
      >
        <VideoThumbnail src={video.thumbnailUrl} title={video.title} />
        <Badge
          tone="muted"
          className="absolute bottom-2 right-2 bg-black/80 text-white"
          aria-label={`Duration ${formatDuration(video.durationSeconds)}`}
        >
          {formatDuration(video.durationSeconds)}
        </Badge>
      </a>
      <div className="flex gap-3 pt-3">
        {resolvedChannelHref ? (
          <a
            href={resolvedChannelHref}
            aria-label={`Visit ${channelName}`}
            className={cx('shrink-0 rounded-full', focusRing)}
          >
            <Avatar
              {...(resolvedChannel?.avatarUrl ? { src: resolvedChannel.avatarUrl } : {})}
              alt=""
              name={channelName}
              size="md"
            />
          </a>
        ) : (
          <span className="shrink-0">
            <Avatar
              {...(resolvedChannel?.avatarUrl ? { src: resolvedChannel.avatarUrl } : {})}
              alt=""
              name={channelName}
              size="md"
            />
          </span>
        )}
        <div className="min-w-0">
          <a
            href={href}
            className={cx(
              'line-clamp-2 block font-sans font-semibold text-foreground hover:text-primary',
              focusRing,
            )}
          >
            {video.title}
          </a>
          {resolvedChannelHref ? (
            <a
              href={resolvedChannelHref}
              className={cx(
                'mt-1 block truncate font-sans text-sm text-muted-foreground hover:text-foreground',
                focusRing,
              )}
            >
              {channelName}
            </a>
          ) : (
            <p className="mt-1 truncate font-sans text-sm text-muted-foreground">{channelName}</p>
          )}
          <p className="mt-0.5 font-sans text-sm text-muted-foreground">{metadata}</p>
        </div>
      </div>
    </article>
  );
}

export interface VideoCardSkeletonProps {
  className?: string;
}

export function VideoCardSkeleton({ className }: VideoCardSkeletonProps) {
  return (
    <div role="status" className={cx('min-w-0', className)} aria-label="Loading video">
      <Skeleton className="aspect-video w-full" />
      <div className="flex gap-3 pt-3">
        <Skeleton circle className="h-10 w-10 shrink-0" />
        <div className="flex-1 space-y-2 pt-1">
          <Skeleton className="h-4 w-11/12" />
          <Skeleton className="h-4 w-8/12" />
          <Skeleton className="h-3 w-6/12" />
        </div>
      </div>
    </div>
  );
}
