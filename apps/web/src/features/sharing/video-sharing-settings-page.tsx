'use client';

import { Button, Checkbox, ErrorState, Page, Spinner, Text } from '@w3ds/ui';
import { useRouter } from 'next/navigation';
import { type FormEvent, useEffect, useState } from 'react';
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
    return 'Could not save access settings. Try again.';
  const error = (response as { error?: unknown }).error;
  if (!error || typeof error !== 'object') return 'Could not save access settings. Try again.';
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' && message
    ? message
    : 'Could not save access settings. Try again.';
}

function copyRelativeLink(relativeUrl: string, promptMessage: string): Promise<void> {
  const url = new URL(relativeUrl, window.location.origin).toString();
  if (!navigator.clipboard?.writeText) {
    window.prompt(promptMessage, url);
    return Promise.resolve();
  }
  return navigator.clipboard.writeText(url).catch(() => {
    window.prompt(promptMessage, url);
  });
}

export function VideoSharingSettingsPage({ videoId }: { videoId: string }) {
  const router = useRouter();
  const [state, setState] = useState<LoadState>('loading');
  const [policy, setPolicy] = useState<ManagedVideoSharingPolicy>();
  const [audience, setAudience] = useState<ManagedVideoSharingPolicy['audience']>('private');
  const [people, setPeople] = useState('');
  const [saving, setSaving] = useState(false);
  const [unpublishing, setUnpublishing] = useState(false);
  const [unpublishConfirmed, setUnpublishConfirmed] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    setState('loading');
    setPolicy(undefined);
    setError(undefined);
    setNotice(undefined);
    setUnpublishConfirmed(false);
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
        if (next.video.id !== videoId) {
          setState('error');
          return;
        }
        setPolicy(next);
        setAudience(next.audience);
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

  const isDraftPolicy =
    policy?.video.status === 'draft' && audience !== 'private' && audience !== 'groups';

  const save = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!policy || policy.video.id !== videoId || unpublishing || audience === 'groups') return;
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
        if (next.video.id !== videoId) {
          setError('Could not save access settings. Try again.');
          return;
        }
        setPolicy(next);
        setAudience(next.audience);
        setPeople(next.readerENames.join('\n'));
        setNotice('Access settings saved.');
      } catch {
        setError('Could not save access settings. Try again.');
      } finally {
        setSaving(false);
      }
    })();
  };

  const copyPrivateLink = () => {
    if (!policy?.shareUrl || policy.video.id !== videoId || policy.video.status !== 'published')
      return;
    void copyRelativeLink(policy.shareUrl, 'Copy this private share link:').then(() => {
      setNotice('Private share link copied. You and the eID names below can open it.');
    });
  };

  const copyWatchLink = () => {
    if (
      !policy?.watchUrl ||
      policy.video.id !== videoId ||
      policy.video.status !== 'published' ||
      (policy.audience !== 'public' && policy.audience !== 'unlisted')
    )
      return;
    const isLinkOnly = policy.audience === 'unlisted';
    const message = isLinkOnly
      ? 'Link-only watch link copied. It will not appear in the public catalogue.'
      : 'Public video link copied.';
    void copyRelativeLink(
      policy.watchUrl,
      isLinkOnly ? 'Copy this link-only watch link:' : 'Copy this public video link:',
    ).then(() => setNotice(message));
  };

  const openPrivatePlayer = () => {
    if (
      policy?.shareUrl &&
      policy.audience === 'people' &&
      policy.video.id === videoId &&
      policy.video.status === 'published'
    ) {
      router.push(policy.shareUrl);
    }
  };

  const openWatchPlayer = () => {
    if (
      policy?.watchUrl &&
      (policy.audience === 'public' || policy.audience === 'unlisted') &&
      policy.video.id === videoId &&
      policy.video.status === 'published'
    ) {
      router.push(policy.watchUrl);
    }
  };

  const unpublish = () => {
    const managedVideo = policy?.video;
    if (
      managedVideo?.id !== videoId ||
      managedVideo.status !== 'published' ||
      !unpublishConfirmed ||
      saving ||
      unpublishing
    )
      return;
    setUnpublishing(true);
    setError(undefined);
    setNotice(undefined);
    void (async () => {
      try {
        const response = await fetch(`/api/videos/${encodeURIComponent(videoId)}/unpublish`, {
          method: 'POST',
        });
        const body = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
        if (response.status === 401) {
          router.replace(`/login?returnTo=${encodeURIComponent(`/videos/${videoId}/sharing`)}`);
          return;
        }
        if (!response.ok) {
          setError(messageFrom(body));
          return;
        }
        router.push(`/upload?draft=${encodeURIComponent(videoId)}`);
      } catch {
        setError('Could not unpublish this video. Try again.');
      } finally {
        setUnpublishing(false);
      }
    })();
  };

  return (
    <ApplicationShell currentHref="/?tab=yours">
      <Page
        title={policy ? `Manage access: ${policy.video.title}` : 'Manage access'}
        description="Decide who can watch this Vidak-hosted video. Vidak checks a recipient’s signed-in eID before every private-share preview and playback request. Public and link-only videos use their canonical player links."
        containerSize="lg"
        actions={
          <Button variant="secondary" onClick={() => router.push('/?tab=yours')}>
            Back to my videos
          </Button>
        }
      >
        {state === 'loading' ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner size="sm" /> Loading access settings…
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
            title="Could not load access settings"
            description="Try returning to your video space and opening this video again."
            action={<Button onClick={() => router.push('/?tab=yours')}>Back to my videos</Button>}
          />
        ) : null}
        {state === 'ready' && policy ? (
          <div className="max-w-2xl space-y-8">
            <form className="space-y-6" onSubmit={save}>
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
                    value="unlisted"
                    checked={audience === 'unlisted'}
                    onChange={() => setAudience('unlisted')}
                  />
                  <span>
                    <strong className="text-foreground">Anyone with the link</strong>
                    <span className="mt-1 block text-sm text-muted-foreground">
                      Anyone with this video’s direct link can watch. It will not appear in Vidak’s
                      public catalogue.
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
                      You and the listed eID names can open the private link and play the video.
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

              {audience === 'groups' ? (
                <aside
                  className="rounded-lg border border-warning/30 bg-warning/5 p-4 text-sm text-muted-foreground"
                  role="status"
                >
                  <strong className="text-foreground">
                    This video has a legacy group access policy stored.
                  </strong>{' '}
                  Vidak cannot verify or edit group membership here. Choose a supported audience
                  above to deliberately replace this access policy.
                </aside>
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
                <strong className="text-foreground">W3DS groups:</strong> group-based sharing will
                be enabled once Vidak can write the same policy to eVault and verify group
                membership there. It is intentionally unavailable here instead of granting hosted
                media based only on a pasted group name.
              </aside>
              {isDraftPolicy ? (
                <Text size="sm" tone="muted">
                  This choice is saved now and becomes watchable after the video is published with
                  ready media.
                </Text>
              ) : null}
              {policy.video.status === 'draft' ? (
                <Text size="sm" tone="muted">
                  This is still a draft. You can prepare its audience now, then finish editing and
                  publish when its media is ready.
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
                <Button
                  type="submit"
                  disabled={unpublishing || audience === 'groups'}
                  isLoading={saving}
                  loadingText="Saving"
                >
                  Save access settings
                </Button>
                {policy.shareUrl &&
                policy.audience === 'people' &&
                policy.video.id === videoId &&
                policy.video.status === 'published' ? (
                  <>
                    <Button type="button" variant="secondary" onClick={copyPrivateLink}>
                      Copy private share link
                    </Button>
                    <Button type="button" variant="secondary" onClick={openPrivatePlayer}>
                      Open private player
                    </Button>
                  </>
                ) : null}
                {policy.watchUrl &&
                (policy.audience === 'public' || policy.audience === 'unlisted') &&
                policy.video.id === videoId &&
                policy.video.status === 'published' ? (
                  <>
                    <Button type="button" variant="secondary" onClick={copyWatchLink}>
                      {policy.audience === 'unlisted'
                        ? 'Copy link-only watch link'
                        : 'Copy public video link'}
                    </Button>
                    <Button type="button" variant="secondary" onClick={openWatchPlayer}>
                      {policy.audience === 'unlisted'
                        ? 'Open link-only player'
                        : 'Open public player'}
                    </Button>
                  </>
                ) : null}
              </div>
            </form>

            {policy.video.status === 'published' ? (
              <section
                className="space-y-4 rounded-xl border border-danger/30 bg-danger/5 p-5"
                aria-labelledby="unpublish-video-heading"
              >
                <div className="space-y-1">
                  <h2 id="unpublish-video-heading" className="font-semibold text-foreground">
                    Unpublish this video
                  </h2>
                  <p className="text-sm text-muted-foreground">
                    This stops playback now and returns the video to an editable draft. Its media,
                    ownership, and current access choice stay in your account. If you publish again
                    without changing it, that audience resumes; choose Only me and save first to
                    revoke future access.
                  </p>
                </div>
                <Checkbox
                  checked={unpublishConfirmed}
                  onChange={(event) => setUnpublishConfirmed(event.target.checked)}
                  label="I understand that this stops playback now and keeps the current access choice for a later republish."
                />
                <Button
                  type="button"
                  variant="danger"
                  disabled={!unpublishConfirmed || saving}
                  isLoading={unpublishing}
                  loadingText="Unpublishing"
                  onClick={unpublish}
                >
                  Unpublish and return to draft
                </Button>
              </section>
            ) : null}
          </div>
        ) : null}
      </Page>
    </ApplicationShell>
  );
}
