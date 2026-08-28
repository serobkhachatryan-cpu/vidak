'use client';

import type {
  ChannelImportProvider,
  ChannelImportProviderStatus,
  ImportedChannel,
} from '@w3ds/types';
import { Badge, Button, EmptyState, Input, Label, Skeleton, Text } from '@w3ds/ui';
import { useId, useState } from 'react';

const providerNames: Record<ChannelImportProvider, string> = {
  youtube: 'YouTube',
  vimeo: 'Vimeo',
};

function channelStatus(channel: ImportedChannel): {
  label: string;
  tone: 'success' | 'warning' | 'danger' | 'muted';
} {
  switch (channel.status) {
    case 'ready':
      return { label: 'Ready', tone: 'success' };
    case 'syncing':
      return { label: 'Importing', tone: 'warning' };
    case 'needs_reconnect':
      return { label: 'Reconnect needed', tone: 'warning' };
    case 'failed':
      return { label: 'Needs attention', tone: 'danger' };
    default:
      return { label: 'Connected', tone: 'muted' };
  }
}

export interface ChannelImportsSectionProps {
  providers: readonly ChannelImportProviderStatus[];
  channels: readonly ImportedChannel[];
  isLoading?: boolean;
  pendingProvider?: ChannelImportProvider;
  isAddingPublicYouTube?: boolean;
  error?: string;
  success?: string;
  onConnect: (provider: ChannelImportProvider) => void;
  onAddPublicYouTube?: (source: string) => void;
  onRetry?: () => void;
}

/** Links provider catalogues only; provider media remains on its original service. */
export function ChannelImportsSection({
  providers,
  channels,
  isLoading = false,
  pendingProvider,
  isAddingPublicYouTube = false,
  error,
  success,
  onConnect,
  onAddPublicYouTube,
  onRetry,
}: ChannelImportsSectionProps) {
  const publicChannelId = useId();
  const [publicChannelSource, setPublicChannelSource] = useState('');
  if (isLoading) {
    return (
      <div
        role="status"
        aria-busy="true"
        aria-label="Loading channel imports"
        className="space-y-3"
      >
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-20 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="rounded-md border border-border bg-muted/40 p-4">
        <Text className="font-semibold">Link a channel, not a copy of your files.</Text>
        <Text size="sm" tone="muted" className="mt-1">
          Add a public YouTube channel by link, or connect a channel you own when its provider is
          available. Videos keep playing from YouTube or Vimeo; Vidak never downloads or republishes
          their media.
        </Text>
      </div>

      <form
        className="space-y-3 rounded-md border border-border p-4"
        onSubmit={(event) => {
          event.preventDefault();
          const source = publicChannelSource.trim();
          if (source) onAddPublicYouTube?.(source);
        }}
      >
        <div className="space-y-1">
          <Text className="font-semibold">Add a public YouTube channel</Text>
          <Text size="sm" tone="muted">
            Paste a channel link. Vidak lists its latest public videos; private and unlisted videos
            are never requested.
          </Text>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row">
          <div className="min-w-0 flex-1 space-y-2">
            <Label htmlFor={publicChannelId}>YouTube channel URL</Label>
            <Input
              id={publicChannelId}
              type="url"
              inputMode="url"
              placeholder="https://www.youtube.com/channel/UC…"
              value={publicChannelSource}
              disabled={isAddingPublicYouTube}
              onChange={(event) => setPublicChannelSource(event.target.value)}
            />
          </div>
          <div className="sm:self-end">
            <Button
              type="submit"
              disabled={!onAddPublicYouTube || !publicChannelSource.trim()}
              isLoading={isAddingPublicYouTube}
              loadingText="Adding channel"
            >
              Add channel
            </Button>
          </div>
        </div>
        <Text size="sm" tone="muted">
          Use a canonical channel link like youtube.com/channel/UC…; handles and search-result URLs
          are not accepted.
        </Text>
      </form>

      <ul className="space-y-3" aria-label="Available channel providers">
        {providers.map((provider) => {
          const name = providerNames[provider.provider];
          const available = provider.available;
          const pending = pendingProvider === provider.provider;
          return (
            <li
              key={provider.provider}
              className="flex flex-col gap-3 rounded-md border border-border px-4 py-4 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Text className="font-semibold">{name}</Text>
                  <Badge tone={available ? 'success' : 'muted'}>
                    {available ? 'Ready to connect' : 'Owner connection unavailable'}
                  </Badge>
                </div>
                <Text size="sm" tone="muted">
                  {available
                    ? `Connect an account to add its authorized ${name} channels to Vidak.`
                    : name +
                      ' owner connection is not available yet. You can still add a public YouTube channel above.'}
                </Text>
              </div>
              {available && (
                <Button
                  size="sm"
                  isLoading={pending}
                  loadingText="Opening provider"
                  aria-label={`Connect ${name} channel`}
                  onClick={() => onConnect(provider.provider)}
                >
                  Connect {name}
                </Button>
              )}
            </li>
          );
        })}
      </ul>

      <div className="space-y-3">
        <div>
          <Text className="font-semibold">Your imported channels</Text>
          <Text size="sm" tone="muted" className="mt-1">
            Public channels you add and owner channels you approve appear here.
          </Text>
        </div>
        {channels.length === 0 ? (
          <EmptyState
            icon="◌"
            title="No imported channels yet"
            description="Add a public YouTube channel above, or connect an owner-authorized channel when available."
          />
        ) : (
          <ul className="space-y-3">
            {channels.map((channel) => {
              const status = channelStatus(channel);
              return (
                <li
                  key={channel.id}
                  className="flex flex-col gap-3 rounded-md border border-border px-4 py-4 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    {channel.thumbnailUrl ? (
                      <img
                        src={channel.thumbnailUrl}
                        alt=""
                        className="h-10 w-10 rounded-full border border-border object-cover"
                      />
                    ) : (
                      <div aria-hidden="true" className="h-10 w-10 rounded-full bg-muted" />
                    )}
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Text className="truncate font-semibold">{channel.title}</Text>
                        <Badge tone={status.tone}>{status.label}</Badge>
                        <Badge tone="muted">
                          {channel.access === 'public' ? 'Public channel' : 'Owner-approved'}
                        </Badge>
                      </div>
                      <Text size="sm" tone="muted">
                        {channel.access === 'public'
                          ? 'Public YouTube · ' +
                            channel.importedVideoCount +
                            ' latest videos in Vidak'
                          : providerNames[channel.provider] +
                            ' · ' +
                            channel.importedVideoCount +
                            ' videos in Vidak'}
                      </Text>
                    </div>
                  </div>
                  <a
                    href={channel.sourceUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-sm font-semibold text-primary underline underline-offset-4"
                  >
                    Open source channel
                  </a>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {success && (
        <Text size="sm" tone="success" role="status">
          {success}
        </Text>
      )}
      {error && (
        <div
          role="alert"
          className="flex flex-col gap-3 rounded-md border border-danger/30 bg-danger/5 p-4 sm:flex-row sm:items-center sm:justify-between"
        >
          <Text size="sm" tone="danger">
            {error}
          </Text>
          {onRetry && (
            <Button size="sm" variant="secondary" onClick={onRetry}>
              Try again
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
