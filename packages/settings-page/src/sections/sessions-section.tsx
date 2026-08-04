'use client';

import type { AuthDeviceSession } from '@w3ds/types';
import { Badge, Button, EmptyState, Text } from '@w3ds/ui';

function formatTimestamp(value: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(value));
  } catch {
    return value;
  }
}

export interface SessionsSectionProps {
  sessions: readonly AuthDeviceSession[];
  pendingSessionId?: string;
  error?: string;
  empty?: boolean;
  onRevoke: (sessionId: string) => void;
}

export function SessionsSection({
  sessions,
  pendingSessionId,
  error,
  empty = false,
  onRevoke,
}: SessionsSectionProps) {
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
                Last active {formatTimestamp(session.lastActiveAt)}
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
