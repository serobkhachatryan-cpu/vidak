'use client';

import type {
  ChannelImportProvider,
  ChannelImportProviderStatus,
  ImportedChannel,
} from '@w3ds/types';
import { Badge, Button, EmptyState, Skeleton, Text } from '@w3ds/ui';

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
  error?: string;
  success?: string;
  onConnect: (provider: ChannelImportProvider) => void;
  onRetry?: () => void;
}

/** Links provider catalogues only; provider media remains on its original service. */
export function ChannelImportsSection({
  providers,
  channels,
  isLoading = false,
  pendingProvider,
  error,
  success,
  onConnect,
  onRetry,
}: ChannelImportsSectionProps) {
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
          Vidak reads the channel and video information you authorize. Videos continue to play from
          YouTube or Vimeo, so private files are never downloaded or republished without your
          action.
        </Text>
      </div>

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
                    {available ? 'Ready to connect' : 'Not configured yet'}
                  </Badge>
                </div>
                <Text size="sm" tone="muted">
                  {available
                    ? `Connect an account to add its authorized ${name} channels to Vidak.`
                    : `${name} import is being prepared.`}
                </Text>
              </div>
              <Button
                size="sm"
                disabled={!available}
                isLoading={pending}
                loadingText="Opening provider"
                aria-label={`Connect ${name} channel`}
                onClick={() => onConnect(provider.provider)}
              >
                Connect {name}
              </Button>
            </li>
          );
        })}
      </ul>

      <div className="space-y-3">
        <div>
          <Text className="font-semibold">Your imported channels</Text>
          <Text size="sm" tone="muted" className="mt-1">
            Only channels returned by the provider account you approve appear here.
          </Text>
        </div>
        {channels.length === 0 ? (
          <EmptyState
            icon="◌"
            title="No imported channels yet"
            description="Connect YouTube or Vimeo to bring an authorized channel into Vidak."
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
                      </div>
                      <Text size="sm" tone="muted">
                        {providerNames[channel.provider]} · {channel.importedVideoCount} videos in
                        Vidak
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
