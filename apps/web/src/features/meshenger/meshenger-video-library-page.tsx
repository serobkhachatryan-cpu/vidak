'use client';

import { Button, EmptyState, ErrorState, Page, Spinner } from '@w3ds/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApplicationShell } from '../../components/application-shell';

type LibraryVideo = {
  id: string;
  kind: 'call-recording' | 'video-message' | 'file';
  title: string;
  durationSeconds?: number;
  shape?: string;
  createdAt?: string;
  streamIds: string[];
};

type LibraryConversation = {
  id: string;
  kind: 'personal' | 'group';
  title: string;
  participantCount?: number;
  role?: 'admin' | 'participant';
  updatedAt?: string;
};

type LibraryMessage = {
  id: string;
  type: string;
  content?: string;
  replyToId?: string;
  createdAt?: string;
  edited: boolean;
};

type LibraryState =
  | { status: 'loading' }
  | { status: 'ready'; items: LibraryVideo[]; conversations: LibraryConversation[]; messages: LibraryMessage[] }
  | { status: 'error'; message: string };

export function MeshengerVideoLibraryPage() {
  const [state, setState] = useState<LibraryState>({ status: 'loading' });
  const load = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      const response = await fetch('/api/meshenger/videos', { cache: 'no-store' });
      const body = (await response.json()) as {
        items?: LibraryVideo[];
        conversations?: LibraryConversation[];
        messages?: LibraryMessage[];
        error?: { message?: string };
      };
      if (!response.ok || !Array.isArray(body.items)) {
        throw new Error(body.error?.message ?? 'Meshenger videos are unavailable.');
      }
      setState({
        status: 'ready',
        items: body.items,
        conversations: Array.isArray(body.conversations) ? body.conversations : [],
        messages: Array.isArray(body.messages) ? body.messages : [],
      });
    } catch (error) {
      setState({
        status: 'error',
        message: error instanceof Error ? error.message : 'Meshenger videos are unavailable.',
      });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <ApplicationShell currentHref="/meshenger">
      <Page
        title="Meshenger"
        description="Your authorized Meshenger conversations, messages, call recordings, circles, and video files—read privately through W3DS."
        actions={
          <Button variant="secondary" onClick={() => void load()}>
            Refresh library
          </Button>
        }
      >
        {state.status === 'ready' ? (
          <div className="mb-10 grid gap-6 lg:grid-cols-2">
            <section aria-labelledby="meshenger-conversations" className="space-y-3">
              <div>
                <h2 id="meshenger-conversations" className="text-lg font-semibold text-foreground">
                  Conversations
                </h2>
                <p className="text-sm text-muted-foreground">
                  Personal chats and groups available through your current eVault access.
                </p>
              </div>
              {state.conversations.length ? (
                <div className="grid gap-3 sm:grid-cols-2">
                  {state.conversations.map((conversation) => (
                    <article key={conversation.id} className="rounded-xl border border-border bg-surface-raised p-4">
                      <p className="text-xs font-semibold uppercase tracking-wide text-primary">
                        {conversation.kind === 'group' ? 'Group' : 'Personal chat'}
                      </p>
                      <h3 className="mt-1 font-semibold text-foreground">{conversation.title}</h3>
                      <p className="mt-1 text-sm text-muted-foreground">{conversationDetails(conversation)}</p>
                    </article>
                  ))}
                </div>
              ) : (
                <p className="rounded-xl border border-dashed border-border p-4 text-sm text-muted-foreground">
                  No Meshenger conversations are available through your current eVault access.
                </p>
              )}
            </section>
            <section aria-labelledby="meshenger-messages" className="space-y-3">
              <div>
                <h2 id="meshenger-messages" className="text-lg font-semibold text-foreground">Latest messages</h2>
                <p className="text-sm text-muted-foreground">Your 12 most recent authorized Meshenger messages.</p>
              </div>
              <MessageList messages={state.messages} />
            </section>
          </div>
        ) : null}
        {state.status === 'loading' ? (
          <div className="flex min-h-56 items-center justify-center gap-2 text-sm text-muted-foreground">
            <Spinner size="sm" /> Reading your Meshenger workspace…
          </div>
        ) : state.status === 'error' ? (
          <ErrorState
            title="Could not load Meshenger"
            description={state.message}
            retry={() => void load()}
          />
        ) : state.items.length === 0 ? (
          <EmptyState
            title="No Meshenger videos found"
            description="When videos are available in your W3DS vault, they will appear here."
          />
        ) : (
          <div className="grid gap-6 sm:grid-cols-2 xl:grid-cols-3">
            {state.items.map((video) => (
              <article
                key={video.id}
                className="overflow-hidden rounded-xl border border-border bg-surface-raised"
              >
                <SegmentedVideoPlayer video={video} />
                <div className="space-y-1 p-4">
                  <p className="text-xs font-semibold uppercase tracking-wide text-primary">
                    {label(video)}
                  </p>
                  <h2 className="font-semibold text-foreground">{video.title}</h2>
                  <p className="text-sm text-muted-foreground">{details(video)}</p>
                </div>
              </article>
            ))}
          </div>
        )}
      </Page>
    </ApplicationShell>
  );
}

function SegmentedVideoPlayer({ video }: { video: LibraryVideo }) {
  const [segmentIndex, setSegmentIndex] = useState(0);
  const continuePlayback = useRef(false);
  const player = useRef<HTMLVideoElement>(null);
  const streamId = video.streamIds[segmentIndex] ?? video.streamIds[0];

  useEffect(() => {
    setSegmentIndex(0);
    continuePlayback.current = false;
  }, [video.id]);

  if (!streamId) return null;

  const nextSegment = () => {
    if (segmentIndex >= video.streamIds.length - 1) return;
    continuePlayback.current = true;
    setSegmentIndex((current) => current + 1);
  };

  const resumeWhenReady = () => {
    if (!continuePlayback.current) return;
    continuePlayback.current = false;
    void player.current?.play().catch(() => {
      // Browser autoplay rules may require the viewer to press play again.
    });
  };

  return (
    <>
      {/* biome-ignore lint/a11y/useMediaCaption: Historical source recordings do not include caption tracks. */}
      <video
        key={streamId}
        ref={player}
        aria-label={video.title}
        className="aspect-video w-full bg-black"
        controls
        preload="metadata"
        src={`/api/meshenger/videos/${encodeURIComponent(streamId)}`}
        onCanPlay={resumeWhenReady}
        onEnded={nextSegment}
      />
      {video.streamIds.length > 1 ? (
        <p className="px-4 pt-3 text-xs text-muted-foreground" aria-live="polite">
          Recording part {segmentIndex + 1} of {video.streamIds.length} · continues automatically
        </p>
      ) : null}
    </>
  );
}

function label(video: LibraryVideo): string {
  if (video.kind === 'call-recording') return 'Call recording';
  if (video.kind === 'video-message')
    return video.shape === 'circle' ? 'Video circle' : 'Video message';
  return 'Video file';
}

function details(video: LibraryVideo): string {
  const values = [
    video.durationSeconds !== undefined ? formatDuration(video.durationSeconds) : undefined,
    video.createdAt ? new Date(video.createdAt).toLocaleDateString() : undefined,
  ].filter(Boolean);
  return values.join(' · ') || 'Meshenger';
}

function MessageList({ messages }: { messages: LibraryMessage[] }) {
  if (!messages.length) {
    return (
      <p className="rounded-xl border border-dashed border-border p-4 text-sm text-muted-foreground">
        No messages are available through your current eVault access.
      </p>
    );
  }
  return (
    <ol className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface-raised">
      {messages.slice(0, 12).map((message) => (
        <li key={message.id} className="space-y-1 p-4">
          <div className="flex flex-wrap gap-2 text-xs font-semibold uppercase tracking-wide text-primary">
            <span>{messageLabel(message)}</span>
            {message.edited ? <span className="text-muted-foreground">Edited</span> : null}
          </div>
          <p className="text-sm text-foreground">{message.content ?? 'Media or system message'}</p>
          <p className="text-xs text-muted-foreground">{messageDetails(message)}</p>
        </li>
      ))}
    </ol>
  );
}

function conversationDetails(conversation: LibraryConversation): string {
  const values = [
    conversation.participantCount ? `${conversation.participantCount} people` : undefined,
    conversation.role,
    conversation.updatedAt ? `Updated ${new Date(conversation.updatedAt).toLocaleDateString()}` : undefined,
  ].filter(Boolean);
  return values.join(' · ') || 'Meshenger';
}

function messageLabel(message: LibraryMessage): string {
  if (message.type === 'circle') return 'Video circle';
  if (message.type === 'video') return 'Video message';
  return message.type;
}

function messageDetails(message: LibraryMessage): string {
  const values = [
    message.replyToId ? 'Reply' : undefined,
    message.createdAt ? new Date(message.createdAt).toLocaleString() : undefined,
  ].filter(Boolean);
  return values.join(' · ') || 'Meshenger';
}

function formatDuration(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}
