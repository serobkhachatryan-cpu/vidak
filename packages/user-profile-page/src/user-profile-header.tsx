import type { UserProfile } from '@w3ds/types';
import { Avatar, Badge, Button, Heading, IconButton, Text } from '@w3ds/ui';
import { useEffect, useId, useRef, useState } from 'react';
import {
  formatFollowers,
  formatFollowing,
  formatJoinDate,
  formatVideoCount,
  formatWebsiteLabel,
} from './format';
import { cx, focusRing } from './styles';

export const userProfileBannerClassName = 'h-28 w-full rounded-xl sm:h-40 lg:h-56';

function ProfileBanner({ profile }: { profile: UserProfile }) {
  return profile.bannerUrl ? (
    <img
      src={profile.bannerUrl}
      alt={`${profile.displayName} profile banner`}
      className={cx(userProfileBannerClassName, 'object-cover')}
    />
  ) : (
    <div
      role="img"
      aria-label={`${profile.displayName} profile banner`}
      className={cx(
        userProfileBannerClassName,
        'bg-gradient-to-r from-primary/40 via-primary/15 to-surface-raised',
      )}
    />
  );
}

function FollowButton({
  following,
  onToggle,
  displayName,
}: {
  following: boolean;
  onToggle: () => void;
  displayName: string;
}) {
  return (
    <Button
      variant={following ? 'secondary' : 'primary'}
      onClick={onToggle}
      aria-pressed={following}
      aria-label={`${following ? 'Unfollow' : 'Follow'} ${displayName}`}
      className="shrink-0"
    >
      {following ? 'Following' : 'Follow'}
    </Button>
  );
}

function ShareButton({ displayName, onShare }: { displayName: string; onShare: () => void }) {
  return (
    <Button
      variant="secondary"
      onClick={onShare}
      aria-label={`Share ${displayName}'s profile`}
      className="shrink-0"
    >
      Share
    </Button>
  );
}

function MoreActionsMenu({ displayName }: { displayName: string }) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div ref={containerRef} className="relative shrink-0">
      <IconButton
        variant="ghost"
        aria-label={`More actions for ${displayName}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((current) => !current)}
      >
        ···
      </IconButton>
      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label={`More actions for ${displayName}`}
          className="absolute right-0 z-10 mt-2 min-w-44 rounded-md border border-border bg-surface p-1 shadow-md"
        >
          <button
            type="button"
            role="menuitem"
            disabled
            className={cx(
              'block w-full rounded px-3 py-2 text-left font-sans text-sm text-muted-foreground',
              focusRing,
            )}
          >
            More actions coming soon
          </button>
        </div>
      )}
    </div>
  );
}

export function UserProfileHeader({
  profile,
  followerCount,
  followingCount,
  videoCount,
  following,
  onFollowToggle,
  onShare,
}: {
  profile: UserProfile;
  followerCount: number;
  followingCount: number;
  videoCount: number;
  following: boolean;
  onFollowToggle: () => void;
  onShare: () => void;
}) {
  const joinedAt = formatJoinDate(profile.joinedAt);
  const summary = [
    formatFollowers(followerCount),
    formatFollowing(followingCount),
    formatVideoCount(videoCount),
  ].join(' · ');
  const meta = [
    profile.location,
    profile.websiteUrl ? formatWebsiteLabel(profile.websiteUrl) : undefined,
    joinedAt ? `Joined ${joinedAt}` : undefined,
  ].filter(Boolean);

  return (
    <header className="space-y-4">
      <ProfileBanner profile={profile} />
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 flex-col gap-4 sm:flex-row sm:items-center">
          <Avatar
            {...(profile.avatarUrl ? { src: profile.avatarUrl } : {})}
            alt=""
            name={profile.displayName}
            size="xl"
            className="sm:h-28 sm:w-28 sm:text-2xl"
          />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Heading as="h1" size="xl">
                {profile.displayName}
              </Heading>
              {profile.isVerified && (
                <Badge tone="muted" aria-label="Verified profile">
                  <span aria-hidden="true" className="mr-1">
                    ✓
                  </span>
                  Verified
                </Badge>
              )}
            </div>
            <Text size="sm" tone="muted" className="mt-1">
              @{profile.handle}
            </Text>
            <Text size="sm" tone="muted" className="mt-1">
              {summary}
            </Text>
            {profile.bio && (
              <Text size="sm" tone="muted" className="mt-2 line-clamp-2 max-w-2xl">
                {profile.bio}
              </Text>
            )}
            {meta.length > 0 && (
              <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1 font-sans text-sm text-muted-foreground">
                {profile.location && <li>{profile.location}</li>}
                {profile.websiteUrl && (
                  <li>
                    <a
                      href={profile.websiteUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={cx('text-primary hover:underline', focusRing)}
                    >
                      {formatWebsiteLabel(profile.websiteUrl)}
                    </a>
                  </li>
                )}
                {joinedAt && <li>Joined {joinedAt}</li>}
              </ul>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <FollowButton
            following={following}
            onToggle={onFollowToggle}
            displayName={profile.displayName}
          />
          <ShareButton displayName={profile.displayName} onShare={onShare} />
          <MoreActionsMenu displayName={profile.displayName} />
        </div>
      </div>
    </header>
  );
}
