const compactNumber = new Intl.NumberFormat('en', {
  notation: 'compact',
  maximumFractionDigits: 1,
});

const joinDate = new Intl.DateTimeFormat('en', { month: 'long', year: 'numeric' });

export const formatCompact = (value: number) => compactNumber.format(value);
export const formatFollowers = (count: number) =>
  `${formatCompact(count)} ${count === 1 ? 'follower' : 'followers'}`;
export const formatFollowing = (count: number) => `${formatCompact(count)} following`;
export const formatVideoCount = (count: number) =>
  `${formatCompact(count)} ${count === 1 ? 'video' : 'videos'}`;

/** Join dates are shown at month precision: the exact day adds noise to a profile summary. */
export function formatJoinDate(value: string): string | undefined {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : joinDate.format(date);
}

export function isPublicProfileHandle(handle: string | null | undefined): boolean {
  const value = handle?.trim().replace(/^@/, '') ?? '';
  if (!value || value.startsWith('w3ds_')) return false;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return false;
  return /^[a-z0-9][a-z0-9_-]{2,29}$/i.test(value);
}
export function formatWebsiteLabel(url: string): string {
  return url.replace(/^https?:\/\//i, '').replace(/\/$/, '');
}
