import { type AuthUser, type AuthUserPermissions, createAuthUser, type Role } from '@w3ds/auth';
import type { UserPreferences } from '@w3ds/types';
import { mergeUserPreferences } from '@w3ds/types';
import { and, eq, gt, inArray } from 'drizzle-orm';
import type { W3dsDatabase } from './db/client';
import {
  userPreferences,
  w3dsLoginOffers,
  w3dsPlatformSessions,
  w3dsPlatformUsers,
} from './db/schema';
import { W3dsAuthError } from './w3ds-auth-errors';

export type OfferStatus = 'pending' | 'verifying' | 'completed' | 'expired' | 'failed';

export interface StoredOffer {
  id: string;
  sessionId: string;
  expiresAt: number;
  status: OfferStatus;
  platformSessionId?: string;
  errorCode?: string;
}

export interface StoredPlatformSession {
  id: string;
  user: AuthUser;
  accessJti: string;
  refreshJti: string;
  accessExpiresAt: number;
  refreshExpiresAt: number;
  revoked: boolean;
  createdAt: number;
  updatedAt: number;
}

export type VerifiedFullNameDecision = 'granted' | 'declined';

export interface StoredAvatarMedia {
  storageKey: string;
  contentType: string;
}

export interface UpdateUserProfileRecordInput {
  userId: string;
  displayName: string;
  /** `undefined` leaves the avatar unchanged; `null` clears it. */
  avatarUrl?: string | null;
}

export interface CreateOfferRecordInput {
  id: string;
  sessionId: string;
  expiresAt: number;
}

export interface CreateSessionRecordInput {
  id: string;
  user: AuthUser;
  accessJti: string;
  refreshJti: string;
  accessExpiresAt: number;
  refreshExpiresAt: number;
}

export interface RotateSessionRecordInput {
  sessionId: string;
  expectedRefreshJti: string;
  accessJti: string;
  refreshJti: string;
  accessExpiresAt: number;
  refreshExpiresAt: number;
}

/**
 * Durable persistence for W3DS auth offers, users, and sessions.
 * Runtime production uses PostgreSQL; in-memory exists only for unit tests.
 */
export interface W3dsAuthStore {
  createOffer(input: CreateOfferRecordInput): Promise<StoredOffer>;
  getOfferById(offerId: string): Promise<StoredOffer | undefined>;
  getOfferBySessionId(sessionId: string): Promise<StoredOffer | undefined>;
  /**
   * Atomically claims a pending, unexpired offer for verification.
   * Returns undefined when the offer is missing, expired, or already used.
   */
  claimOfferForVerification(sessionId: string, now: number): Promise<StoredOffer | undefined>;
  completeOffer(offerId: string, platformSessionId: string): Promise<void>;
  failOffer(offerId: string, errorCode: string): Promise<void>;
  markOfferExpired(offerId: string): Promise<void>;

  findUserByEName(eName: string): Promise<AuthUser | undefined>;
  findUserById(userId: string): Promise<AuthUser | undefined>;
  /**
   * Inserts a user when the eName is new; returns the existing row on conflict.
   */
  findOrCreateUser(user: AuthUser): Promise<AuthUser>;
  /** Updates only local platform profile fields for the given user id. */
  updateUserProfile(input: UpdateUserProfileRecordInput): Promise<AuthUser>;
  getVerifiedFullNameDecision(userId: string): Promise<VerifiedFullNameDecision | undefined>;
  setVerifiedFullNameDecision(userId: string, decision: VerifiedFullNameDecision): Promise<void>;
  getUserPreferences(userId: string): Promise<UserPreferences | undefined>;
  upsertUserPreferences(userId: string, preferences: UserPreferences): Promise<UserPreferences>;
  getAvatarMedia(userId: string): Promise<StoredAvatarMedia | undefined>;
  setAvatarMedia(
    userId: string,
    media: StoredAvatarMedia & { avatarUrl: string },
  ): Promise<AuthUser>;

  createSession(input: CreateSessionRecordInput): Promise<StoredPlatformSession>;
  getSessionById(sessionId: string): Promise<StoredPlatformSession | undefined>;
  /**
   * Active (non-revoked, unexpired refresh) sessions for a single platform user.
   */
  listActiveSessionsByUserId(userId: string, now: number): Promise<StoredPlatformSession[]>;
  /**
   * Rotates token identifiers when the expected refresh jti still matches.
   * Returns undefined on mismatch, revocation, or missing session.
   */
  rotateSession(input: RotateSessionRecordInput): Promise<StoredPlatformSession | undefined>;
  revokeSession(sessionId: string): Promise<void>;
}

function toAuthUser(row: {
  id: string;
  eName: string;
  eVaultId: string;
  eVaultUri: string | null;
  displayName: string;
  handle: string | null;
  avatarUrl: string | null;
  bio: string | null;
  roles: Role[];
  capabilities: string[];
  permissions: AuthUserPermissions;
}): AuthUser {
  return createAuthUser({
    id: row.id,
    displayName: row.displayName,
    roles: row.roles,
    ...(row.handle ? { handle: row.handle } : {}),
    ...(row.avatarUrl ? { avatarUrl: row.avatarUrl } : {}),
    ...(row.bio ? { bio: row.bio } : {}),
    eName: row.eName,
    eVaultId: row.eVaultId,
    ...(row.eVaultUri ? { eVaultUri: row.eVaultUri } : {}),
    capabilities: row.capabilities,
    permissions: row.permissions,
  });
}

function offerFromRow(row: {
  id: string;
  sessionId: string;
  expiresAt: Date;
  status: OfferStatus;
  platformSessionId: string | null;
  errorCode: string | null;
}): StoredOffer {
  return {
    id: row.id,
    sessionId: row.sessionId,
    expiresAt: row.expiresAt.getTime(),
    status: row.status,
    ...(row.platformSessionId ? { platformSessionId: row.platformSessionId } : {}),
    ...(row.errorCode ? { errorCode: row.errorCode } : {}),
  };
}

function cloneUser(user: AuthUser): AuthUser {
  return { ...user, profile: { ...user.profile } };
}

function cloneSession(session: StoredPlatformSession): StoredPlatformSession {
  return { ...session, user: cloneUser(session.user) };
}

/** In-memory store for explicit unit-test injection only. Never a production fallback. */
export class InMemoryW3dsAuthStore implements W3dsAuthStore {
  private readonly offersById = new Map<string, StoredOffer>();
  private readonly offersBySessionId = new Map<string, StoredOffer>();
  private readonly usersByEName = new Map<string, AuthUser>();
  private readonly usersById = new Map<string, AuthUser>();
  private readonly sessionsById = new Map<string, StoredPlatformSession>();
  private readonly verifiedFullNameDecisions = new Map<string, VerifiedFullNameDecision>();
  private readonly preferencesByUserId = new Map<string, UserPreferences>();
  private readonly avatarMediaByUserId = new Map<string, StoredAvatarMedia>();
  /** Serializes claim operations to emulate atomic DB updates in tests. */
  private claimChain: Promise<unknown> = Promise.resolve();

  async createOffer(input: CreateOfferRecordInput): Promise<StoredOffer> {
    const offer: StoredOffer = {
      id: input.id,
      sessionId: input.sessionId,
      expiresAt: input.expiresAt,
      status: 'pending',
    };
    this.offersById.set(offer.id, offer);
    this.offersBySessionId.set(offer.sessionId, offer);
    return { ...offer };
  }

  async getOfferById(offerId: string): Promise<StoredOffer | undefined> {
    const offer = this.offersById.get(offerId);
    return offer ? { ...offer } : undefined;
  }

  async getOfferBySessionId(sessionId: string): Promise<StoredOffer | undefined> {
    const offer = this.offersBySessionId.get(sessionId);
    return offer ? { ...offer } : undefined;
  }

  async claimOfferForVerification(
    sessionId: string,
    now: number,
  ): Promise<StoredOffer | undefined> {
    const run = async () => {
      const offer = this.offersBySessionId.get(sessionId);
      if (!offer) return undefined;
      if (offer.status === 'pending' && offer.expiresAt <= now) {
        offer.status = 'expired';
        return undefined;
      }
      if (offer.status !== 'pending' || offer.expiresAt <= now) return undefined;
      offer.status = 'verifying';
      return { ...offer };
    };
    const result = this.claimChain.then(run, run);
    this.claimChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async completeOffer(offerId: string, platformSessionId: string): Promise<void> {
    const offer = this.offersById.get(offerId);
    if (offer?.status !== 'verifying') {
      throw new W3dsAuthError('Authentication session was already used.', 'consumed_session', 401);
    }
    offer.status = 'completed';
    offer.platformSessionId = platformSessionId;
  }

  async failOffer(offerId: string, errorCode: string): Promise<void> {
    const offer = this.offersById.get(offerId);
    if (!offer) return;
    if (offer.status === 'verifying' || offer.status === 'pending') {
      offer.status = 'failed';
      offer.errorCode = errorCode;
    }
  }

  async markOfferExpired(offerId: string): Promise<void> {
    const offer = this.offersById.get(offerId);
    if (!offer) return;
    if (offer.status === 'pending' || offer.status === 'verifying') {
      offer.status = 'expired';
    }
  }

  async findUserByEName(eName: string): Promise<AuthUser | undefined> {
    const user = this.usersByEName.get(eName);
    return user ? cloneUser(user) : undefined;
  }

  async findUserById(userId: string): Promise<AuthUser | undefined> {
    const user = this.usersById.get(userId);
    return user ? cloneUser(user) : undefined;
  }

  async findOrCreateUser(user: AuthUser): Promise<AuthUser> {
    const existing = this.usersByEName.get(user.eName);
    if (existing) return cloneUser(existing);
    this.usersByEName.set(user.eName, user);
    this.usersById.set(user.id, user);
    return cloneUser(user);
  }

  async updateUserProfile(input: UpdateUserProfileRecordInput): Promise<AuthUser> {
    const existing = this.usersById.get(input.userId);
    if (!existing) {
      throw new W3dsAuthError('Authentication is required.', 'invalid_session', 401);
    }
    let avatarUrl = existing.profile.avatarUrl ?? existing.avatarUrl;
    if (input.avatarUrl === null) avatarUrl = undefined;
    else if (input.avatarUrl !== undefined) avatarUrl = input.avatarUrl;
    const updated = createAuthUser({
      id: existing.id,
      displayName: input.displayName,
      roles: existing.roles,
      ...(existing.email ? { email: existing.email } : {}),
      ...(avatarUrl ? { avatarUrl } : {}),
      ...(existing.profile.handle ? { handle: existing.profile.handle } : {}),
      ...(existing.profile.bio ? { bio: existing.profile.bio } : {}),
      eName: existing.eName,
      eVaultId: existing.eVaultId,
      ...(existing.eVaultUri ? { eVaultUri: existing.eVaultUri } : {}),
      capabilities: existing.capabilities,
      permissions: existing.permissions,
    });
    this.usersById.set(updated.id, updated);
    this.usersByEName.set(updated.eName, updated);
    for (const session of this.sessionsById.values()) {
      if (session.user.id === updated.id) session.user = updated;
    }
    return cloneUser(updated);
  }

  async getVerifiedFullNameDecision(userId: string): Promise<VerifiedFullNameDecision | undefined> {
    return this.verifiedFullNameDecisions.get(userId);
  }

  async setVerifiedFullNameDecision(
    userId: string,
    decision: VerifiedFullNameDecision,
  ): Promise<void> {
    this.verifiedFullNameDecisions.set(userId, decision);
  }

  async getUserPreferences(userId: string): Promise<UserPreferences | undefined> {
    const stored = this.preferencesByUserId.get(userId);
    return stored ? mergeUserPreferences(stored) : undefined;
  }

  async upsertUserPreferences(
    userId: string,
    preferences: UserPreferences,
  ): Promise<UserPreferences> {
    const next = mergeUserPreferences(preferences);
    this.preferencesByUserId.set(userId, next);
    return mergeUserPreferences(next);
  }

  async getAvatarMedia(userId: string): Promise<StoredAvatarMedia | undefined> {
    const media = this.avatarMediaByUserId.get(userId);
    return media ? { ...media } : undefined;
  }

  async setAvatarMedia(
    userId: string,
    media: StoredAvatarMedia & { avatarUrl: string },
  ): Promise<AuthUser> {
    this.avatarMediaByUserId.set(userId, {
      storageKey: media.storageKey,
      contentType: media.contentType,
    });
    const existing = this.usersById.get(userId);
    if (!existing) {
      throw new W3dsAuthError('Authentication is required.', 'invalid_session', 401);
    }
    return this.updateUserProfile({
      userId,
      displayName: existing.displayName,
      avatarUrl: media.avatarUrl,
    });
  }

  async createSession(input: CreateSessionRecordInput): Promise<StoredPlatformSession> {
    const now = Date.now();
    const session: StoredPlatformSession = {
      id: input.id,
      user: input.user,
      accessJti: input.accessJti,
      refreshJti: input.refreshJti,
      accessExpiresAt: input.accessExpiresAt,
      refreshExpiresAt: input.refreshExpiresAt,
      revoked: false,
      createdAt: now,
      updatedAt: now,
    };
    this.sessionsById.set(session.id, session);
    return cloneSession(session);
  }

  async getSessionById(sessionId: string): Promise<StoredPlatformSession | undefined> {
    const session = this.sessionsById.get(sessionId);
    return session ? cloneSession(session) : undefined;
  }

  async listActiveSessionsByUserId(userId: string, now: number): Promise<StoredPlatformSession[]> {
    return [...this.sessionsById.values()]
      .filter(
        (session) =>
          session.user.id === userId && !session.revoked && session.refreshExpiresAt > now,
      )
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map(cloneSession);
  }

  async rotateSession(input: RotateSessionRecordInput): Promise<StoredPlatformSession | undefined> {
    const session = this.sessionsById.get(input.sessionId);
    if (!session || session.revoked || session.refreshJti !== input.expectedRefreshJti) {
      return undefined;
    }
    session.accessJti = input.accessJti;
    session.refreshJti = input.refreshJti;
    session.accessExpiresAt = input.accessExpiresAt;
    session.refreshExpiresAt = input.refreshExpiresAt;
    session.updatedAt = Date.now();
    return cloneSession(session);
  }

  async revokeSession(sessionId: string): Promise<void> {
    const session = this.sessionsById.get(sessionId);
    if (session) {
      session.revoked = true;
      session.updatedAt = Date.now();
    }
  }

  /** Test/e2e helper: export durable snapshot for cross-process stub stores. */
  exportSnapshot(): {
    offers: StoredOffer[];
    users: AuthUser[];
    sessions: StoredPlatformSession[];
    verifiedFullNameDecisions: Record<string, VerifiedFullNameDecision>;
    preferences: Record<string, UserPreferences>;
    avatarMedia: Record<string, StoredAvatarMedia>;
  } {
    return {
      offers: [...this.offersById.values()].map((offer) => ({ ...offer })),
      users: [...this.usersById.values()].map(cloneUser),
      sessions: [...this.sessionsById.values()].map(cloneSession),
      verifiedFullNameDecisions: Object.fromEntries(this.verifiedFullNameDecisions),
      preferences: Object.fromEntries(
        [...this.preferencesByUserId.entries()].map(([id, value]) => [
          id,
          mergeUserPreferences(value),
        ]),
      ),
      avatarMedia: Object.fromEntries(
        [...this.avatarMediaByUserId.entries()].map(([id, value]) => [id, { ...value }]),
      ),
    };
  }

  /** Test/e2e helper: replace in-memory state from a durable snapshot. */
  importSnapshot(snapshot: {
    offers: StoredOffer[];
    users: AuthUser[];
    sessions: StoredPlatformSession[];
    verifiedFullNameDecisions?: Record<string, VerifiedFullNameDecision>;
    preferences?: Record<string, UserPreferences>;
    avatarMedia?: Record<string, StoredAvatarMedia>;
  }): void {
    this.offersById.clear();
    this.offersBySessionId.clear();
    this.usersByEName.clear();
    this.usersById.clear();
    this.sessionsById.clear();
    this.verifiedFullNameDecisions.clear();
    this.preferencesByUserId.clear();
    this.avatarMediaByUserId.clear();
    for (const offer of snapshot.offers) {
      const copy = { ...offer };
      this.offersById.set(copy.id, copy);
      this.offersBySessionId.set(copy.sessionId, copy);
    }
    for (const user of snapshot.users) {
      const copy = cloneUser(user);
      this.usersById.set(copy.id, copy);
      this.usersByEName.set(copy.eName, copy);
    }
    for (const session of snapshot.sessions) {
      this.sessionsById.set(session.id, cloneSession(session));
    }
    for (const [userId, decision] of Object.entries(snapshot.verifiedFullNameDecisions ?? {})) {
      this.verifiedFullNameDecisions.set(userId, decision);
    }
    for (const [userId, value] of Object.entries(snapshot.preferences ?? {})) {
      this.preferencesByUserId.set(userId, mergeUserPreferences(value));
    }
    for (const [userId, media] of Object.entries(snapshot.avatarMedia ?? {})) {
      this.avatarMediaByUserId.set(userId, { ...media });
    }
  }
}

/** PostgreSQL-backed store shared across application instances. */
export class PostgresW3dsAuthStore implements W3dsAuthStore {
  constructor(private readonly db: W3dsDatabase) {}

  async createOffer(input: CreateOfferRecordInput): Promise<StoredOffer> {
    const now = new Date();
    const [row] = await this.db
      .insert(w3dsLoginOffers)
      .values({
        id: input.id,
        sessionId: input.sessionId,
        expiresAt: new Date(input.expiresAt),
        status: 'pending',
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!row)
      throw new W3dsAuthError('Failed to create authentication offer.', 'internal_error', 500);
    return offerFromRow(row);
  }

  async getOfferById(offerId: string): Promise<StoredOffer | undefined> {
    const [row] = await this.db
      .select()
      .from(w3dsLoginOffers)
      .where(eq(w3dsLoginOffers.id, offerId))
      .limit(1);
    return row ? offerFromRow(row) : undefined;
  }

  async getOfferBySessionId(sessionId: string): Promise<StoredOffer | undefined> {
    const [row] = await this.db
      .select()
      .from(w3dsLoginOffers)
      .where(eq(w3dsLoginOffers.sessionId, sessionId))
      .limit(1);
    return row ? offerFromRow(row) : undefined;
  }

  async claimOfferForVerification(
    sessionId: string,
    now: number,
  ): Promise<StoredOffer | undefined> {
    const nowDate = new Date(now);
    return this.db.transaction(async (tx) => {
      const [offer] = await tx
        .select()
        .from(w3dsLoginOffers)
        .where(eq(w3dsLoginOffers.sessionId, sessionId))
        .for('update')
        .limit(1);
      if (!offer) return undefined;

      if (
        (offer.status === 'pending' || offer.status === 'verifying') &&
        offer.expiresAt.getTime() <= now
      ) {
        await tx
          .update(w3dsLoginOffers)
          .set({ status: 'expired', updatedAt: nowDate })
          .where(eq(w3dsLoginOffers.id, offer.id));
        return undefined;
      }

      if (offer.status !== 'pending') return undefined;

      const [updated] = await tx
        .update(w3dsLoginOffers)
        .set({ status: 'verifying', updatedAt: nowDate })
        .where(and(eq(w3dsLoginOffers.id, offer.id), eq(w3dsLoginOffers.status, 'pending')))
        .returning();
      return updated ? offerFromRow(updated) : undefined;
    });
  }

  async completeOffer(offerId: string, platformSessionId: string): Promise<void> {
    const now = new Date();
    const updated = await this.db
      .update(w3dsLoginOffers)
      .set({
        status: 'completed',
        platformSessionId,
        updatedAt: now,
      })
      .where(and(eq(w3dsLoginOffers.id, offerId), eq(w3dsLoginOffers.status, 'verifying')))
      .returning({ id: w3dsLoginOffers.id });
    if (updated.length === 0) {
      throw new W3dsAuthError('Authentication session was already used.', 'consumed_session', 401);
    }
  }

  async failOffer(offerId: string, errorCode: string): Promise<void> {
    const now = new Date();
    await this.db
      .update(w3dsLoginOffers)
      .set({
        status: 'failed',
        errorCode,
        updatedAt: now,
      })
      .where(
        and(
          eq(w3dsLoginOffers.id, offerId),
          inArray(w3dsLoginOffers.status, ['pending', 'verifying']),
        ),
      );
  }

  async markOfferExpired(offerId: string): Promise<void> {
    const now = new Date();
    await this.db
      .update(w3dsLoginOffers)
      .set({ status: 'expired', updatedAt: now })
      .where(
        and(
          eq(w3dsLoginOffers.id, offerId),
          inArray(w3dsLoginOffers.status, ['pending', 'verifying']),
        ),
      );
  }

  async findUserByEName(eName: string): Promise<AuthUser | undefined> {
    const [row] = await this.db
      .select()
      .from(w3dsPlatformUsers)
      .where(eq(w3dsPlatformUsers.eName, eName))
      .limit(1);
    return row ? toAuthUser(row) : undefined;
  }

  async findUserById(userId: string): Promise<AuthUser | undefined> {
    const [row] = await this.db
      .select()
      .from(w3dsPlatformUsers)
      .where(eq(w3dsPlatformUsers.id, userId))
      .limit(1);
    return row ? toAuthUser(row) : undefined;
  }

  async findOrCreateUser(user: AuthUser): Promise<AuthUser> {
    const now = new Date();
    const inserted = await this.db
      .insert(w3dsPlatformUsers)
      .values({
        id: user.id,
        eName: user.eName,
        eVaultId: user.eVaultId,
        eVaultUri: user.eVaultUri ?? null,
        displayName: user.displayName,
        handle: user.profile.handle ?? null,
        avatarUrl: user.profile.avatarUrl ?? user.avatarUrl ?? null,
        bio: user.profile.bio ?? null,
        roles: [...user.roles],
        capabilities: [...user.capabilities],
        permissions: user.permissions,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({ target: w3dsPlatformUsers.eName })
      .returning();
    if (inserted[0]) return toAuthUser(inserted[0]);
    const existing = await this.findUserByEName(user.eName);
    if (!existing) {
      throw new W3dsAuthError('Failed to persist platform user.', 'internal_error', 500);
    }
    return existing;
  }

  async updateUserProfile(input: UpdateUserProfileRecordInput): Promise<AuthUser> {
    const existing = await this.findUserById(input.userId);
    if (!existing) {
      throw new W3dsAuthError('Authentication is required.', 'invalid_session', 401);
    }
    let avatarUrl = existing.profile.avatarUrl ?? existing.avatarUrl ?? null;
    if (input.avatarUrl === null) avatarUrl = null;
    else if (input.avatarUrl !== undefined) avatarUrl = input.avatarUrl;
    const now = new Date();
    const [row] = await this.db
      .update(w3dsPlatformUsers)
      .set({
        displayName: input.displayName,
        avatarUrl,
        updatedAt: now,
      })
      .where(eq(w3dsPlatformUsers.id, input.userId))
      .returning();
    if (!row) {
      throw new W3dsAuthError('Authentication is required.', 'invalid_session', 401);
    }
    return toAuthUser(row);
  }

  async getVerifiedFullNameDecision(userId: string): Promise<VerifiedFullNameDecision | undefined> {
    const [row] = await this.db
      .select({ decision: w3dsPlatformUsers.verifiedFullNameDecision })
      .from(w3dsPlatformUsers)
      .where(eq(w3dsPlatformUsers.id, userId))
      .limit(1);
    return parseVerifiedFullNameDecision(row?.decision);
  }

  async setVerifiedFullNameDecision(
    userId: string,
    decision: VerifiedFullNameDecision,
  ): Promise<void> {
    const now = new Date();
    const [row] = await this.db
      .update(w3dsPlatformUsers)
      .set({
        verifiedFullNameDecision: decision,
        updatedAt: now,
      })
      .where(eq(w3dsPlatformUsers.id, userId))
      .returning({ id: w3dsPlatformUsers.id });
    if (!row) {
      throw new W3dsAuthError('Authentication is required.', 'invalid_session', 401);
    }
  }

  async getUserPreferences(userId: string): Promise<UserPreferences | undefined> {
    const [row] = await this.db
      .select()
      .from(userPreferences)
      .where(eq(userPreferences.userId, userId))
      .limit(1);
    if (!row) return undefined;
    return mergeUserPreferences({
      appearance: row.appearance,
      language: row.language,
      notifications: row.notifications,
      privacy: row.privacy,
    });
  }

  async upsertUserPreferences(
    userId: string,
    preferences: UserPreferences,
  ): Promise<UserPreferences> {
    const now = new Date();
    const next = mergeUserPreferences(preferences);
    await this.db
      .insert(userPreferences)
      .values({
        userId,
        appearance: next.appearance,
        language: next.language,
        notifications: next.notifications,
        privacy: next.privacy,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: userPreferences.userId,
        set: {
          appearance: next.appearance,
          language: next.language,
          notifications: next.notifications,
          privacy: next.privacy,
          updatedAt: now,
        },
      });
    return next;
  }

  async getAvatarMedia(userId: string): Promise<StoredAvatarMedia | undefined> {
    const [row] = await this.db
      .select({
        storageKey: w3dsPlatformUsers.avatarStorageKey,
        contentType: w3dsPlatformUsers.avatarContentType,
      })
      .from(w3dsPlatformUsers)
      .where(eq(w3dsPlatformUsers.id, userId))
      .limit(1);
    if (!row?.storageKey || !row.contentType) return undefined;
    return { storageKey: row.storageKey, contentType: row.contentType };
  }

  async setAvatarMedia(
    userId: string,
    media: StoredAvatarMedia & { avatarUrl: string },
  ): Promise<AuthUser> {
    const existing = await this.findUserById(userId);
    if (!existing) {
      throw new W3dsAuthError('Authentication is required.', 'invalid_session', 401);
    }
    const now = new Date();
    const [row] = await this.db
      .update(w3dsPlatformUsers)
      .set({
        avatarUrl: media.avatarUrl,
        avatarStorageKey: media.storageKey,
        avatarContentType: media.contentType,
        updatedAt: now,
      })
      .where(eq(w3dsPlatformUsers.id, userId))
      .returning();
    if (!row) {
      throw new W3dsAuthError('Authentication is required.', 'invalid_session', 401);
    }
    return toAuthUser(row);
  }

  async createSession(input: CreateSessionRecordInput): Promise<StoredPlatformSession> {
    const now = new Date();
    await this.db.insert(w3dsPlatformSessions).values({
      id: input.id,
      userId: input.user.id,
      accessJti: input.accessJti,
      refreshJti: input.refreshJti,
      accessExpiresAt: new Date(input.accessExpiresAt),
      refreshExpiresAt: new Date(input.refreshExpiresAt),
      revoked: false,
      createdAt: now,
      updatedAt: now,
    });
    return {
      id: input.id,
      user: input.user,
      accessJti: input.accessJti,
      refreshJti: input.refreshJti,
      accessExpiresAt: input.accessExpiresAt,
      refreshExpiresAt: input.refreshExpiresAt,
      revoked: false,
      createdAt: now.getTime(),
      updatedAt: now.getTime(),
    };
  }

  async getSessionById(sessionId: string): Promise<StoredPlatformSession | undefined> {
    const [row] = await this.db
      .select({
        session: w3dsPlatformSessions,
        user: w3dsPlatformUsers,
      })
      .from(w3dsPlatformSessions)
      .innerJoin(w3dsPlatformUsers, eq(w3dsPlatformSessions.userId, w3dsPlatformUsers.id))
      .where(eq(w3dsPlatformSessions.id, sessionId))
      .limit(1);
    if (!row) return undefined;
    return sessionFromRows(row.session, row.user);
  }

  async listActiveSessionsByUserId(userId: string, now: number): Promise<StoredPlatformSession[]> {
    const nowDate = new Date(now);
    const rows = await this.db
      .select({
        session: w3dsPlatformSessions,
        user: w3dsPlatformUsers,
      })
      .from(w3dsPlatformSessions)
      .innerJoin(w3dsPlatformUsers, eq(w3dsPlatformSessions.userId, w3dsPlatformUsers.id))
      .where(
        and(
          eq(w3dsPlatformSessions.userId, userId),
          eq(w3dsPlatformSessions.revoked, false),
          gt(w3dsPlatformSessions.refreshExpiresAt, nowDate),
        ),
      );
    return rows
      .map((row) => sessionFromRows(row.session, row.user))
      .sort((left, right) => right.updatedAt - left.updatedAt);
  }

  async rotateSession(input: RotateSessionRecordInput): Promise<StoredPlatformSession | undefined> {
    const now = new Date();
    const updated = await this.db
      .update(w3dsPlatformSessions)
      .set({
        accessJti: input.accessJti,
        refreshJti: input.refreshJti,
        accessExpiresAt: new Date(input.accessExpiresAt),
        refreshExpiresAt: new Date(input.refreshExpiresAt),
        updatedAt: now,
      })
      .where(
        and(
          eq(w3dsPlatformSessions.id, input.sessionId),
          eq(w3dsPlatformSessions.refreshJti, input.expectedRefreshJti),
          eq(w3dsPlatformSessions.revoked, false),
          gt(w3dsPlatformSessions.refreshExpiresAt, now),
        ),
      )
      .returning({ id: w3dsPlatformSessions.id });
    if (updated.length === 0) return undefined;
    return this.getSessionById(input.sessionId);
  }

  async revokeSession(sessionId: string): Promise<void> {
    const now = new Date();
    await this.db
      .update(w3dsPlatformSessions)
      .set({ revoked: true, updatedAt: now })
      .where(eq(w3dsPlatformSessions.id, sessionId));
  }
}

function sessionFromRows(
  session: {
    id: string;
    accessJti: string;
    refreshJti: string;
    accessExpiresAt: Date;
    refreshExpiresAt: Date;
    revoked: boolean;
    createdAt: Date;
    updatedAt: Date;
  },
  user: {
    id: string;
    eName: string;
    eVaultId: string;
    eVaultUri: string | null;
    displayName: string;
    handle: string | null;
    avatarUrl: string | null;
    bio: string | null;
    roles: Role[];
    capabilities: string[];
    permissions: AuthUserPermissions;
  },
): StoredPlatformSession {
  return {
    id: session.id,
    user: toAuthUser(user),
    accessJti: session.accessJti,
    refreshJti: session.refreshJti,
    accessExpiresAt: session.accessExpiresAt.getTime(),
    refreshExpiresAt: session.refreshExpiresAt.getTime(),
    revoked: session.revoked,
    createdAt: session.createdAt.getTime(),
    updatedAt: session.updatedAt.getTime(),
  };
}

function parseVerifiedFullNameDecision(
  value: string | null | undefined,
): VerifiedFullNameDecision | undefined {
  return value === 'granted' || value === 'declined' ? value : undefined;
}
