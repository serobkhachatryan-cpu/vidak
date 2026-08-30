/** Same-origin public avatar path. Never a storage key or blob URL. */
export function publicUserAvatarPath(userId: string): string {
  return `/api/users/${encodeURIComponent(userId)}/avatar`;
}
