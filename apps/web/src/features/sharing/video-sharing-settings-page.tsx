'use client';

import { Button, ErrorState, Page, Spinner, Text } from '@w3ds/ui';
import { useRouter } from 'next/navigation';
import { type FormEvent, useEffect, useMemo, useState } from 'react';
import { ApplicationShell } from '../../components/application-shell';
import type { ManagedVideoSharingPolicy } from '../../server/video-sharing';

type LoadState = 'loading' | 'ready' | 'missing' | 'error';

function parseENames(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function messageFrom(response: unknown): string {
  if (!response || typeof response !== 'object')
    return 'Could not save sharing settings. Try again.';
  const error = (response as { error?: unknown }).error;
  if (!error || typeof error !== 'object') return 'Could not save sharing settings. Try again.';
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' && message
    ? message
    : 'Could not save sharing settings. Try again.';
}

export function VideoSharingSettingsPage({ videoId }: { videoId: string }) {
  const router = useRouter();
  const [state, setState] = useState<LoadState>('loading');
  const [policy, setPolicy] = useState<ManagedVideoSharingPolicy>();
  const [audience, setAudience] = useState<'private' | 'people' | 'public'>('private');
  const [people, setPeople] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    void fetch(`/api/videos/${encodeURIComponent(videoId)}/sharing`, { cache: 'no-store' })
      .then(async (response) => {
        if (response.status === 401) {
          router.replace(`/login?returnTo=${encodeURIComponent(`/videos/${videoId}/sharing`)}`);
          return undefined;
        }
        if (response.status === 404) return null;
        if (!response.ok) throw new Error();
        return (await response.json()) as ManagedVideoSharingPolicy;
      })
      .then((next) => {
        if (cancelled || next === undefined) return;
        if (next === null) {
          setState('missing');
          return;
        }
        setPolicy(next);
        setAudience(next.audience === 'groups' ? 'private' : next.audience);
        setPeople(next.readerENames.join('\n'));
        setState('ready');
      })
      .catch(() => {
        if (!cancelled) setState('error');
      });
    return () => {
      cancelled = true;
    };
  }, [router, videoId]);

  const isDraftPolicy = useMemo(
    () => !policy?.shareUrl && audience !== 'private',
    [audience, policy?.shareUrl],
  );

  const save = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    setError(undefined);
    setNotice(undefined);
    void (async () => {
      try {
        const response = await fetch(`/api/videos/${encodeURIComponent(videoId)}/sharing`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            audience,
            ...(audience === 'people' ? { readerENames: parseENames(people) } : {}),
          }),
        });
        const body = (await response.json().catch(() => ({}))) as
          | ManagedVideoSharingPolicy
          | { error?: { message?: string } };
        if (!response.ok) {
          setError(messageFrom(body));
          return;
        }
        const next = body as ManagedVideoSharingPolicy;
        setPolicy(next);
        setAudience(next.audience === 'groups' ? 'private' : next.audience);
        setPeople(next.readerENames.join('\n'));
        setNotice('Sharing settings saved.');
      } catch {
        setError('Could not save sharing settings. Try again.');
      } finally {
        setSaving(false);
      }
    })();
  };

  const copyLink = () => {
    if (!policy?.shareUrl) return;
    const url = new URL(policy.shareUrl, window.location.origin).toString();
    void navigator.clipboard
      .writeText(url)
      .then(() => setNotice('Private share link copied. Only the eID names below can open it.'))
      .catch(() => window.prompt('Copy this private share link:', url));
  };

  return (
    <ApplicationShell currentHref="/">
      <Page
        title="Sharing settings"
        description="Decide who can watch this Vidak-hosted video. A private share link only locates the video; Vidak checks the recipient’s signed-in eID before every preview and playback request."
        containerSize="lg"
        actions={
          <Button variant="secondary" onClick={() => router.push('/?tab=yours')}>
            Back to my videos
          </Button>
        }
      >
        {state === 'loading' ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner size="sm" /> Loading sharing settings…
          </div>
        ) : null}
        {state === 'missing' ? (
          <ErrorState
            title="Video not found"
            description="Only the owner can manage this video's sharing settings."
            action={<Button onClick={() => router.push('/?tab=yours')}>Back to my videos</Button>}
          />
        ) : null}
        {state === 'error' ? (
          <ErrorState
            title="Could not load sharing settings"
            description="Try returning to your video space and opening this video again."
            action={<Button onClick={() => router.push('/?tab=yours')}>Back to my videos</Button>}
          />
        ) : null}
        {state === 'ready' ? (
          <form className="max-w-2xl space-y-6" onSubmit={save}>
            <fieldset className="space-y-3">
              <legend className="text-lg font-semibold text-foreground">Who can watch?</legend>
              <label className="flex cursor-pointer gap-3 rounded-lg border border-border p-4">
                <input
                  type="radio"
                  name="audience"
                  value="private"
                  checked={audience === 'private'}
                  onChange={() => setAudience('private')}
                />
                <span>
                  <strong className="text-foreground">Only me</strong>
                  <span className="mt-1 block text-sm text-muted-foreground">
                    The video stays private. Existing private links stop working.
                  </span>
                </span>
              </label>
              <label className="flex cursor-pointer gap-3 rounded-lg border border-border p-4">
                <input
                  type="radio"
                  name="audience"
                  value="people"
                  checked={audience === 'people'}
                  onChange={() => setAudience('people')}
                />
                <span>
                  <strong className="text-foreground">Specific people</strong>
                  <span className="mt-1 block text-sm text-muted-foreground">
                    Only the listed eID names can open the private link and play the video.
                  </span>
                </span>
              </label>
              <label className="flex cursor-pointer gap-3 rounded-lg border border-border p-4">
                <input
                  type="radio"
                  name="audience"
                  value="public"
                  checked={audience === 'public'}
                  onChange={() => setAudience('public')}
                />
                <span>
                  <strong className="text-foreground">Anyone</strong>
                  <span className="mt-1 block text-sm text-muted-foreground">
                    Publish this video in Vidak’s public catalogue. No eID is required to watch.
                  </span>
                </span>
              </label>
            </fieldset>

            {audience === 'people' ? (
              <label className="block space-y-2">
                <span className="font-medium text-foreground">People’s eID names</span>
                <span className="block text-sm text-muted-foreground">
                  One per line or separated by commas. Each must start with @. Vidak verifies and
                  saves the canonical eID identity when you save.
                </span>
                <textarea
                  value={people}
                  onChange={(event) => setPeople(event.target.value)}
                  rows={6}
                  placeholder="@friend.w3id"
                  className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm text-foreground"
                />
              </label>
            ) : null}

            <aside className="rounded-lg border border-border bg-muted/30 p-4 text-sm text-muted-foreground">
              <strong className="text-foreground">Revocation:</strong> changing who can watch
              immediately stops Vidak access for removed people and rotates the private link. A
              recipient cannot reuse an old link to continue watching.
            </aside>
            <aside className="rounded-lg border border-border bg-muted/30 p-4 text-sm text-muted-foreground">
              <strong className="text-foreground">Policy scope:</strong> this setting takes effect
              immediately for media Vidak hosts. It does not rewrite access policies on existing
              files stored by another W3DS application.
            </aside>
            <aside className="rounded-lg border border-border bg-muted/30 p-4 text-sm text-muted-foreground">
              <strong className="text-foreground">W3DS groups:</strong> group-based sharing will be
              enabled once Vidak can write the same policy to eVault and verify group membership
              there. It is intentionally unavailable here instead of granting hosted media based
              only on a pasted group name.
            </aside>
            {isDraftPolicy ? (
              <Text size="sm" tone="muted">
                This choice is saved now and becomes watchable after the video is published with
                ready media.
              </Text>
            ) : null}
            {error ? (
              <Text size="sm" tone="danger" role="alert">
                {error}
              </Text>
            ) : null}
            {notice ? (
              <Text size="sm" tone="success" role="status">
                {notice}
              </Text>
            ) : null}
            <div className="flex flex-wrap gap-3">
              <Button type="submit" isLoading={saving} loadingText="Saving">
                Save sharing settings
              </Button>
              {policy?.shareUrl && policy.audience === 'people' ? (
                <Button type="button" variant="secondary" onClick={copyLink}>
                  Copy private share link
                </Button>
              ) : null}
            </div>
          </form>
        ) : null}
      </Page>
    </ApplicationShell>
  );
}
