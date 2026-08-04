import type { Channel, Playlist, SearchResultType, SearchSort } from '@w3ds/types';
import { Avatar, Card, Skeleton } from './primitives';

const cx = (...classes: Array<string | false | null | undefined>) =>
  classes.filter(Boolean).join(' ');

const focusRing =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background';

export const searchResultLabels: Record<SearchResultType, string> = {
  videos: 'Videos',
  channels: 'Channels',
  playlists: 'Playlists',
};

export interface SearchFiltersProps {
  value: SearchResultType;
  onChange: (value: SearchResultType) => void;
}

export function SearchFilters({ value, onChange }: SearchFiltersProps) {
  return (
    <div role="tablist" aria-label="Result type" className="flex gap-2 overflow-x-auto pb-1">
      {(Object.keys(searchResultLabels) as SearchResultType[]).map((type) => (
        <button
          key={type}
          type="button"
          role="tab"
          aria-selected={value === type}
          tabIndex={value === type ? 0 : -1}
          onClick={() => onChange(type)}
          className={cx(
            'shrink-0 rounded-full px-4 py-2 font-sans text-sm font-medium transition-colors',
            focusRing,
            value === type
              ? 'bg-primary text-primary-foreground'
              : 'bg-muted text-muted-foreground hover:bg-border hover:text-foreground',
          )}
        >
          {searchResultLabels[type]}
        </button>
      ))}
    </div>
  );
}

export interface SearchSortControlProps {
  value: SearchSort;
  onChange: (value: SearchSort) => void;
}

export function SearchSortControl({ value, onChange }: SearchSortControlProps) {
  return (
    <label className="flex items-center gap-2 font-sans text-sm text-muted-foreground">
      Sort by
      <select
        value={value}
        onChange={(event) => onChange(event.target.value as SearchSort)}
        className={cx(
          'h-10 rounded-md border border-border bg-surface px-3 font-sans text-sm text-foreground',
          focusRing,
        )}
      >
        <option value="relevance">Relevance</option>
        <option value="uploadDate">Upload date</option>
        <option value="views">Views</option>
      </select>
    </label>
  );
}

export function ChannelSearchResult({ channel }: { channel: Channel }) {
  return (
    <Card className="flex items-center gap-4">
      <Avatar
        {...(channel.avatarUrl ? { src: channel.avatarUrl } : {})}
        name={channel.name}
        size="lg"
      />
      <div className="min-w-0">
        <a
          href={`/channel/${channel.id}`}
          className={cx('font-sans font-semibold hover:text-primary', focusRing)}
        >
          {channel.name}
        </a>
        <p className="mt-1 font-sans text-sm text-muted-foreground">
          @{channel.handle} · {channel.subscriberCount.toLocaleString()} subscribers ·{' '}
          {channel.videoCount} videos
        </p>
        {channel.description && (
          <p className="mt-2 line-clamp-2 font-sans text-sm text-muted-foreground">
            {channel.description}
          </p>
        )}
      </div>
    </Card>
  );
}

export function PlaylistSearchResult({ playlist }: { playlist: Playlist }) {
  return (
    <Card className="flex gap-4">
      <div className="aspect-video w-36 shrink-0 overflow-hidden rounded bg-muted sm:w-48">
        {playlist.thumbnailUrl && (
          <img
            src={playlist.thumbnailUrl}
            alt=""
            className="h-full w-full object-cover"
            loading="lazy"
          />
        )}
      </div>
      <div className="min-w-0">
        <a
          href={`/playlist/${playlist.id}`}
          className={cx('font-sans font-semibold hover:text-primary', focusRing)}
        >
          {playlist.title}
        </a>
        <p className="mt-1 font-sans text-sm text-muted-foreground">
          {playlist.items.length} videos
        </p>
        {playlist.description && (
          <p className="mt-2 line-clamp-2 font-sans text-sm text-muted-foreground">
            {playlist.description}
          </p>
        )}
      </div>
    </Card>
  );
}

export function SearchResultSkeleton({ type = 'videos' }: { type?: SearchResultType }) {
  return type === 'videos' ? (
    <div className="space-y-3" aria-label="Loading search result" role="status">
      <Skeleton className="aspect-video w-full" />
      <Skeleton className="h-4 w-8/12" />
      <Skeleton className="h-3 w-5/12" />
    </div>
  ) : (
    <Card className="flex gap-4" aria-label="Loading search result" role="status">
      <Skeleton circle className="h-14 w-14 shrink-0" />
      <div className="flex-1 space-y-2">
        <Skeleton className="h-4 w-6/12" />
        <Skeleton className="h-3 w-8/12" />
      </div>
    </Card>
  );
}
