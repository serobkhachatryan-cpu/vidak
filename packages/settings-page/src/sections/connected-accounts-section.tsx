'use client';

import type { ConnectedAccount, ConnectedAccountProvider } from '@w3ds/types';
import { Badge, Button, EmptyState, Text } from '@w3ds/ui';
import { connectedAccountLabels } from '../settings-constants';

export interface ConnectedAccountsSectionProps {
  accounts: readonly ConnectedAccount[];
  pendingProvider?: ConnectedAccountProvider;
  error?: string;
  onConnect: (provider: ConnectedAccountProvider) => void;
  onDisconnect: (provider: ConnectedAccountProvider) => void;
}

export function ConnectedAccountsSection({
  accounts,
  pendingProvider,
  error,
  onConnect,
  onDisconnect,
}: ConnectedAccountsSectionProps) {
  if (accounts.length === 0) {
    return (
      <EmptyState
        icon="◌"
        title="No connected accounts"
        description="Link Google, GitHub, or Apple to sign in faster."
      />
    );
  }

  return (
    <div className="space-y-4">
      <ul className="space-y-3">
        {accounts.map((account) => {
          const label = connectedAccountLabels[account.provider];
          const pending = pendingProvider === account.provider;
          return (
            <li
              key={account.provider}
              className="flex flex-col gap-3 rounded-md border border-border px-3 py-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Text className="font-semibold">{label}</Text>
                  <Badge tone={account.connected ? 'success' : 'muted'}>
                    {account.connected ? 'Connected' : 'Not connected'}
                  </Badge>
                </div>
                {account.connected && account.accountLabel && (
                  <Text size="sm" tone="muted">
                    {account.accountLabel}
                  </Text>
                )}
              </div>
              {account.connected ? (
                <Button
                  variant="secondary"
                  size="sm"
                  isLoading={pending}
                  loadingText="Disconnecting"
                  onClick={() => onDisconnect(account.provider)}
                >
                  Disconnect
                </Button>
              ) : (
                <Button
                  size="sm"
                  isLoading={pending}
                  loadingText="Connecting"
                  onClick={() => onConnect(account.provider)}
                >
                  Connect
                </Button>
              )}
            </li>
          );
        })}
      </ul>
      {error && (
        <Text size="sm" tone="danger" role="alert">
          {error}
        </Text>
      )}
    </div>
  );
}
