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

/** Drops the scheme and any trailing slash so a long website URL stays readable inline. */
export function formatWebsiteLabel(url: string): string {
  return url.replace(/^https?:\/\//i, '').replace(/\/$/, '');
}
