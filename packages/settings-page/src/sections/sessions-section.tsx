'use client';

import type { AuthDeviceSession } from '@w3ds/types';
import { Badge, Button, EmptyState, Skeleton, Text } from '@w3ds/ui';
import { formatSettingsTimestamp } from '../format';

export interface SessionsSectionProps {
  sessions: readonly AuthDeviceSession[];
  pendingSessionId?: string;
  error?: string;
  empty?: boolean;
  isLoading?: boolean;
  onRevoke: (sessionId: string) => void;
}

export function SessionsSection({
  sessions,
  pendingSessionId,
  error,
  empty = false,
  isLoading = false,
  onRevoke,
}: SessionsSectionProps) {
  if (isLoading) {
    return (
      <div role="status" aria-busy="true" aria-label="Loading sessions" className="space-y-3">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
      </div>
    );
  }

  if (empty || sessions.length === 0) {
    return (
      <EmptyState
        icon="◌"
        title="No active sessions"
        description="Signed-in devices will appear here."
      />
    );
  }

  return (
    <div className="space-y-4">
      <ul className="space-y-3">
        {sessions.map((session) => (
          <li
            key={session.id}
            className="flex flex-col gap-3 rounded-md border border-border px-3 py-3 sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <Text className="font-semibold">{session.deviceName}</Text>
                {session.current && <Badge tone="primary">This device</Badge>}
              </div>
              <Text size="sm" tone="muted">
                Last active {formatSettingsTimestamp(session.lastActiveAt)}
                {session.location ? ` · ${session.location}` : ''}
                {session.ipAddress ? ` · ${session.ipAddress}` : ''}
              </Text>
            </div>
            {!session.current && (
              <Button
                variant="secondary"
                size="sm"
                isLoading={pendingSessionId === session.id}
                loadingText="Revoking"
                aria-label={`Sign out ${session.deviceName}`}
                onClick={() => onRevoke(session.id)}
              >
                Sign out
              </Button>
            )}
          </li>
        ))}
      </ul>
      {error && (
        <Text size="sm" tone="danger" role="alert">
          {error}
        </Text>
      )}
    </div>
  );
}
