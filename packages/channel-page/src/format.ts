const compactNumber = new Intl.NumberFormat('en', {
  notation: 'compact',
  maximumFractionDigits: 1,
});

const shortDate = new Intl.DateTimeFormat('en', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

export const formatCompact = (value: number) => compactNumber.format(value);
export const formatSubscribers = (count: number) => `${formatCompact(count)} subscribers`;
export const formatVideoCount = (count: number) => `${formatCompact(count)} videos`;
export const formatViews = (count: number) => `${formatCompact(count)} views`;

export function formatDate(value: string): string | undefined {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : shortDate.format(date);
}
