import type {
  CursorPage,
  PaginationParams,
  UpdateUserPreferencesInput,
  UserPreferences,
  UserProfile,
  UserProfileId,
  Video,
  VideoListFilters,
} from '@w3ds/types';
import { defaultUserPreferences, isPublicHandle, looksLikeTechnicalIdentifier } from '@w3ds/types';
import { createCursorPage } from './pagination';

export type ProductionGatewayFeature =
  | 'profile'
  | 'channel'
  | 'feed'
  | 'search'
  | 'settings'
  | 'comments'
  | 'playlists'
  | 'connected-accounts'
  | 'avatar'
  | 'legacy-upload';

/**
 * Typed failure for a production surface that has no durable backend yet.
 * Callers must render an empty or unavailable product state — never mock data.
 */
export class ProductionFeatureUnavailableError extends Error {
  readonly code = 'feature_unavailable';
  readonly feature: ProductionGatewayFeature;

  constructor(feature: ProductionGatewayFeature, message: string) {
    super(message);
    this.name = 'ProductionFeatureUnavailableError';
    this.feature = feature;
  }
}

export function emptyCursorPage<T>(): CursorPage<T> {
  return { items: [] };
}

export function unavailableFeature(
  feature: ProductionGatewayFeature,
  message: string,
): Promise<never> {
  return Promise.reject(new ProductionFeatureUnavailableError(feature, message));
}

export interface AuthUserProjection {
  id?: string;
  displayName?: string;
  avatarUrl?: string;
  eName?: string;
  eVaultId?: string;
  profile?: {
    displayName?: string;
    handle?: string;
    avatarUrl?: string;
    bio?: string;
  };
}

export function userProfileFromAuthUser(
  user: AuthUserProjection,
  requestedId?: UserProfileId,
): UserProfile | undefined {
  const id = typeof user.id === 'string' ? user.id.trim() : '';
  if (!id) return undefined;
  if (requestedId && requestedId !== id) return undefined;

  const displayName = (user.profile?.displayName ?? user.displayName ?? '').trim();
  const handle = isPublicHandle(user.profile?.handle, {
    id,
    ...(user.eName ? { eName: user.eName } : {}),
    ...(user.eVaultId ? { eVaultId: user.eVaultId } : {}),
  })
    ? (user.profile?.handle?.trim().replace(/^@/, '') ?? '')
    : '';
  const avatarUrl = user.profile?.avatarUrl ?? user.avatarUrl;
  const bio = user.profile?.bio?.trim();

  return {
    id,
    handle,
    displayName: looksLikeTechnicalIdentifier(displayName) ? '' : displayName,
    ...(avatarUrl ? { avatarUrl } : {}),
    ...(bio ? { bio } : {}),
    joinedAt: '',
    subscriberCount: 0,
    isVerified: false,
  };
}

export function sessionLocalPreferences(
  stored: UserPreferences | undefined,
  patch?: UpdateUserPreferencesInput,
): UserPreferences {
  const base = stored ?? defaultUserPreferences;
  if (!patch) {
    return {
      appearance: base.appearance,
      language: base.language,
      notifications: { ...base.notifications },
      privacy: { ...base.privacy },
    };
  }
  return {
    appearance: patch.appearance ?? base.appearance,
    language: patch.language ?? base.language,
    notifications: { ...base.notifications, ...patch.notifications },
    privacy: { ...base.privacy, ...patch.privacy },
  };
}

export function filterPublicVideos(
  page: CursorPage<Video>,
  filters: VideoListFilters | undefined,
  pagination: PaginationParams | undefined,
): CursorPage<Video> {
  let items = page.items.filter((video) => {
    if (video.status !== 'published') return false;
    if (filters?.status && video.status !== filters.status) return false;
    if (filters?.visibility && video.visibility !== filters.visibility) return false;
    if (filters?.channelId && video.channelId !== filters.channelId) return false;
    if (filters?.search) {
      const query = filters.search.trim().toLocaleLowerCase();
      const haystack = `${video.title} ${video.description}`.toLocaleLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });

  if (filters?.sort === 'views') {
    items = [...items].sort((a, b) => b.viewCount - a.viewCount);
  } else if (filters?.sort === 'uploadDate') {
    items = [...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  const filtered = Boolean(filters?.search || filters?.channelId || filters?.sort);
  if (filtered) return createCursorPage(items, pagination);
  return { items, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
}
