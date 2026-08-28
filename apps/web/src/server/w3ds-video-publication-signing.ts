import 'server-only';
import { randomUUID } from 'node:crypto';
import type { Video } from '@w3ds/types';
import { and, eq } from 'drizzle-orm';
import { getCreatorVideoService } from './creator-video';
import { getW3dsDatabase, type W3dsDatabase } from './db/client';
import { w3dsVideoPublicationSigningSessions } from './db/schema';
import { getW3dsAuthService, type VerifiedW3dsIdentity, W3dsAuthError } from './w3ds-auth';

const defaultSessionLifetimeMs = 15 * 60 * 1000;

export type W3dsVideoPublicationSigningStatus =
  | 'pending'
  | 'verifying'
  | 'completed'
  | 'expired'
  | 'failed'
  | 'security_violation';

export interface StoredW3dsVideoPublicationSigningSession {
  id: string;
  videoId: string;
  ownerId: string;
  ownerEName: string;
  expiresAt: number;
  status: W3dsVideoPublicationSigningStatus;
  errorCode?: string;
}

interface CreateW3dsVideoPublicationSigningSessionInput {
  id: string;
  videoId: string;
  ownerId: string;
  ownerEName: string;
  expiresAt: number;
}

/** Durable session state. In-memory storage is available only by explicit test injection. */
export interface W3dsVideoPublicationSigningStore {
  create(
    input: CreateW3dsVideoPublicationSigningSessionInput,
  ): Promise<StoredW3dsVideoPublicationSigningSession>;
  claimForVerification(
    sessionId: string,
    now: number,
  ): Promise<StoredW3dsVideoPublicationSigningSession | undefined>;
  complete(sessionId: string): Promise<void>;
  markSecurityViolation(sessionId: string, code: string): Promise<void>;
  markFailed(sessionId: string, code: string): Promise<void>;
  getForOwner(
    sessionId: string,
    ownerId: string,
    videoId: string,
  ): Promise<StoredW3dsVideoPublicationSigningSession | undefined>;
}

export interface W3dsVideoPublicationSigningOffer {
  sessionId: string;
  qrData: string;
  /** The exact approval statement encoded in the wallet request. */
  approvalMessage: string;
  expiresAt: string;
}

/** Owner-scoped state safe to return to the creator UI while it polls. */
export interface W3dsVideoPublicationSigningOfferStatus {
  sessionId: string;
  videoId: string;
  status: W3dsVideoPublicationSigningStatus;
  expiresAt: string;
  /** Present only after the server verified a signature and published the bound draft. */
  video?: Video;
}

export interface W3dsVideoPublicationSigningCallback {
  sessionId: string;
  signature: string;
  w3id: string;
  message: string;
}

export class W3dsVideoPublicationSigningError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'W3dsVideoPublicationSigningError';
  }
}

export interface W3dsVideoPublicationSigningServiceOptions {
  store: W3dsVideoPublicationSigningStore;
  resolveUser?: (accessToken: string) => Promise<{ id: string; eName: string }>;
  getOwnedDraft?: (accessToken: string, videoId: string) => Promise<Video>;
  getOwnedVideo?: (accessToken: string, videoId: string) => Promise<Video>;
  verifySignature?: (input: {
    w3id: string;
    payload: string;
    signature: string;
  }) => Promise<VerifiedW3dsIdentity>;
  publishVerifiedVideo?: (input: {
    videoId: string;
    ownerId: string;
    ownerEName: string;
  }) => Promise<Video>;
  createId?: () => string;
  now?: () => number;
  sessionLifetimeMs?: number;
}

/**
 * Server-only, opt-in `w3ds://sign` flow for a creator publishing a draft.
 * The wallet signs the random session id; the stored session binds that proof
 * to one local video and one expected eName. No signature is stored.
 */
export class W3dsVideoPublicationSigningService {
  private readonly store: W3dsVideoPublicationSigningStore;
  private readonly resolveUser: (accessToken: string) => Promise<{ id: string; eName: string }>;
  private readonly getOwnedDraft: (accessToken: string, videoId: string) => Promise<Video>;
  private readonly getOwnedVideo: (accessToken: string, videoId: string) => Promise<Video>;
  private readonly verifySignature: NonNullable<
    W3dsVideoPublicationSigningServiceOptions['verifySignature']
  >;
  private readonly publishVerifiedVideo: NonNullable<
    W3dsVideoPublicationSigningServiceOptions['publishVerifiedVideo']
  >;
  private readonly createId: () => string;
  private readonly now: () => number;
  private readonly sessionLifetimeMs: number;

  constructor(options: W3dsVideoPublicationSigningServiceOptions) {
    this.store = options.store;
    this.resolveUser =
      options.resolveUser ??
      (async (accessToken) => (await getW3dsAuthService().getSession(accessToken)).user);
    this.getOwnedDraft =
      options.getOwnedDraft ??
      ((accessToken, videoId) => getCreatorVideoService().getDraft(accessToken, videoId));
    this.getOwnedVideo =
      options.getOwnedVideo ??
      ((accessToken, videoId) => getCreatorVideoService().getOwnedVideo(accessToken, videoId));
    this.verifySignature =
      options.verifySignature ?? ((input) => getW3dsAuthService().verifySignedPayload(input));
    this.publishVerifiedVideo =
      options.publishVerifiedVideo ??
      ((input) => getCreatorVideoService().publishVideoAfterVerifiedSignature(input));
    this.createId = options.createId ?? randomUUID;
    this.now = options.now ?? Date.now;
    this.sessionLifetimeMs = options.sessionLifetimeMs ?? defaultSessionLifetimeMs;
  }

  async createOffer(input: {
    accessToken: string;
    videoId: string;
    publicBaseUrl: string;
  }): Promise<W3dsVideoPublicationSigningOffer> {
    if (!input.accessToken.trim()) {
      throw new W3dsAuthError('Authentication is required.', 'invalid_session', 401);
    }
    const videoId = input.videoId.trim();
    if (!videoId) {
      throw new W3dsVideoPublicationSigningError('Video was not found.', 'not_found', 404);
    }
    const owner = await this.resolveUser(input.accessToken);
    const draft = await this.getOwnedDraft(input.accessToken, videoId);
    const sessionId = this.createId();
    const expiresAt = this.now() + this.sessionLifetimeMs;
    await this.store.create({
      id: sessionId,
      videoId: draft.id,
      ownerId: owner.id,
      ownerEName: owner.eName,
      expiresAt,
    });

    const approvalMessage = buildPublicationApprovalMessage(draft.title, draft.visibility);
    return {
      sessionId,
      qrData: buildSigningUri({
        sessionId,
        videoId: draft.id,
        approvalMessage,
        publicBaseUrl: input.publicBaseUrl,
      }),
      approvalMessage,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  async completeOffer(input: W3dsVideoPublicationSigningCallback): Promise<Video> {
    validateCallback(input);
    const session = await this.store.claimForVerification(input.sessionId, this.now());
    if (!session) {
      throw new W3dsVideoPublicationSigningError(
        'Signing session is unavailable.',
        'invalid_session',
        401,
      );
    }

    if (input.message !== session.id || input.w3id !== session.ownerEName) {
      await this.store.markSecurityViolation(session.id, 'session_or_identity_mismatch');
      throw new W3dsVideoPublicationSigningError(
        'Signing session could not be verified.',
        'invalid_signature',
        401,
      );
    }

    try {
      const identity = await this.verifySignature({
        w3id: input.w3id,
        payload: input.message,
        signature: input.signature,
      });
      if (identity.eName !== session.ownerEName) {
        await this.store.markSecurityViolation(session.id, 'verified_identity_mismatch');
        throw new W3dsVideoPublicationSigningError(
          'Signing session could not be verified.',
          'invalid_signature',
          401,
        );
      }

      const video = await this.publishVerifiedVideo({
        videoId: session.videoId,
        ownerId: session.ownerId,
        ownerEName: session.ownerEName,
      });
      await this.store.complete(session.id);
      return video;
    } catch (error) {
      if (error instanceof W3dsVideoPublicationSigningError) throw error;
      const code = error instanceof W3dsAuthError ? 'invalid_signature' : 'publish_failed';
      await this.store.markFailed(session.id, code);
      if (error instanceof W3dsAuthError) {
        throw new W3dsVideoPublicationSigningError(
          'Signing session could not be verified.',
          'invalid_signature',
          401,
        );
      }
      throw new W3dsVideoPublicationSigningError(
        'Signed video publication is unavailable.',
        'signing_failed',
        500,
      );
    }
  }

  /**
   * Owner-authenticated poll endpoint state. It exposes no signature, eName,
   * or internal error detail, and returns a video only after publication.
   */
  async getOfferStatus(input: {
    accessToken: string;
    sessionId: string;
    videoId: string;
  }): Promise<W3dsVideoPublicationSigningOfferStatus> {
    if (!input.accessToken.trim()) {
      throw new W3dsAuthError('Authentication is required.', 'invalid_session', 401);
    }
    const sessionId = input.sessionId.trim();
    const videoId = input.videoId.trim();
    if (!sessionId || !videoId) {
      throw new W3dsVideoPublicationSigningError(
        'Signing session was not found.',
        'not_found',
        404,
      );
    }
    const owner = await this.resolveUser(input.accessToken);
    const session = await this.store.getForOwner(sessionId, owner.id, videoId);
    if (!session) {
      throw new W3dsVideoPublicationSigningError(
        'Signing session was not found.',
        'not_found',
        404,
      );
    }

    const status =
      session.status === 'pending' && session.expiresAt <= this.now() ? 'expired' : session.status;
    const result: W3dsVideoPublicationSigningOfferStatus = {
      sessionId: session.id,
      videoId: session.videoId,
      status,
      expiresAt: new Date(session.expiresAt).toISOString(),
    };
    if (status === 'completed') {
      result.video = await this.getOwnedVideo(input.accessToken, session.videoId);
    }
    return result;
  }
}

function buildPublicationApprovalMessage(title: string, visibility: Video['visibility']): string {
  const name = title.trim() || 'Untitled video';
  if (visibility === 'public') {
    return `Publish “${name}” publicly on Vidak. Anyone can find and watch it.`;
  }
  if (visibility === 'unlisted') {
    return `Share “${name}” by link on Vidak. Anyone with the link can watch it.`;
  }
  return `Keep “${name}” private in Vidak. Only you can watch it.`;
}

function buildSigningUri(input: {
  sessionId: string;
  videoId: string;
  approvalMessage: string;
  publicBaseUrl: string;
}): string {
  let baseUrl: URL;
  try {
    baseUrl = new URL(input.publicBaseUrl);
  } catch {
    throw new W3dsVideoPublicationSigningError(
      'Signed video publication is unavailable.',
      'invalid_public_origin',
      500,
    );
  }
  if (baseUrl.protocol !== 'https:' && baseUrl.protocol !== 'http:') {
    throw new W3dsVideoPublicationSigningError(
      'Signed video publication is unavailable.',
      'invalid_public_origin',
      500,
    );
  }

  const data = Buffer.from(
    JSON.stringify({
      message: input.approvalMessage,
      sessionId: input.sessionId,
      videoId: input.videoId,
    }),
    'utf8',
  ).toString('base64');
  const uri = new URL('w3ds://sign');
  uri.searchParams.set('session', input.sessionId);
  uri.searchParams.set('data', data);
  uri.searchParams.set(
    'redirect_uri',
    new URL('/api/signing/video-publication/callback', baseUrl).toString(),
  );
  return uri.toString();
}

function validateCallback(input: W3dsVideoPublicationSigningCallback): void {
  const fields = [input.sessionId, input.signature, input.w3id, input.message];
  if (fields.some((field) => typeof field !== 'string' || !field.trim() || field.length > 4096)) {
    throw new W3dsVideoPublicationSigningError(
      'Signing session could not be verified.',
      'invalid_callback',
      400,
    );
  }
}

export class InMemoryW3dsVideoPublicationSigningStore implements W3dsVideoPublicationSigningStore {
  private readonly sessions = new Map<string, StoredW3dsVideoPublicationSigningSession>();
  private claimChain: Promise<unknown> = Promise.resolve();

  async create(
    input: CreateW3dsVideoPublicationSigningSessionInput,
  ): Promise<StoredW3dsVideoPublicationSigningSession> {
    const session: StoredW3dsVideoPublicationSigningSession = { ...input, status: 'pending' };
    this.sessions.set(session.id, session);
    return { ...session };
  }

  async claimForVerification(
    sessionId: string,
    now: number,
  ): Promise<StoredW3dsVideoPublicationSigningSession | undefined> {
    const run = async () => {
      const session = this.sessions.get(sessionId);
      if (!session) return undefined;
      if (
        (session.status === 'pending' || session.status === 'verifying') &&
        session.expiresAt <= now
      ) {
        session.status = 'expired';
        return undefined;
      }
      if (session.status !== 'pending') return undefined;
      session.status = 'verifying';
      return { ...session };
    };
    const result = this.claimChain.then(run, run);
    this.claimChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async complete(sessionId: string): Promise<void> {
    this.transition(sessionId, 'completed');
  }

  async markSecurityViolation(sessionId: string, code: string): Promise<void> {
    this.transition(sessionId, 'security_violation', code);
  }

  async markFailed(sessionId: string, code: string): Promise<void> {
    this.transition(sessionId, 'failed', code);
  }

  async getForOwner(
    sessionId: string,
    ownerId: string,
    videoId: string,
  ): Promise<StoredW3dsVideoPublicationSigningSession | undefined> {
    const session = this.sessions.get(sessionId);
    if (!session || session.ownerId !== ownerId || session.videoId !== videoId) return undefined;
    return { ...session };
  }

  get(sessionId: string): StoredW3dsVideoPublicationSigningSession | undefined {
    const session = this.sessions.get(sessionId);
    return session ? { ...session } : undefined;
  }

  private transition(
    sessionId: string,
    status: Extract<
      W3dsVideoPublicationSigningStatus,
      'completed' | 'failed' | 'security_violation'
    >,
    errorCode?: string,
  ): void {
    const session = this.sessions.get(sessionId);
    if (session?.status !== 'verifying') {
      throw new W3dsVideoPublicationSigningError(
        'Signing session is unavailable.',
        'invalid_session',
        401,
      );
    }
    session.status = status;
    if (errorCode) session.errorCode = errorCode;
  }
}

export class PostgresW3dsVideoPublicationSigningStore implements W3dsVideoPublicationSigningStore {
  constructor(private readonly db: W3dsDatabase) {}

  async create(
    input: CreateW3dsVideoPublicationSigningSessionInput,
  ): Promise<StoredW3dsVideoPublicationSigningSession> {
    const now = new Date();
    const [row] = await this.db
      .insert(w3dsVideoPublicationSigningSessions)
      .values({
        ...input,
        expiresAt: new Date(input.expiresAt),
        status: 'pending',
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!row) {
      throw new W3dsVideoPublicationSigningError(
        'Signed video publication is unavailable.',
        'internal_error',
        500,
      );
    }
    return signingSessionFromRow(row);
  }

  async claimForVerification(
    sessionId: string,
    now: number,
  ): Promise<StoredW3dsVideoPublicationSigningSession | undefined> {
    const nowDate = new Date(now);
    return this.db.transaction(async (tx) => {
      const [session] = await tx
        .select()
        .from(w3dsVideoPublicationSigningSessions)
        .where(eq(w3dsVideoPublicationSigningSessions.id, sessionId))
        .for('update')
        .limit(1);
      if (!session) return undefined;
      if (
        (session.status === 'pending' || session.status === 'verifying') &&
        session.expiresAt.getTime() <= now
      ) {
        await tx
          .update(w3dsVideoPublicationSigningSessions)
          .set({ status: 'expired', updatedAt: nowDate })
          .where(eq(w3dsVideoPublicationSigningSessions.id, session.id));
        return undefined;
      }
      if (session.status !== 'pending') return undefined;
      const [claimed] = await tx
        .update(w3dsVideoPublicationSigningSessions)
        .set({ status: 'verifying', updatedAt: nowDate })
        .where(
          and(
            eq(w3dsVideoPublicationSigningSessions.id, session.id),
            eq(w3dsVideoPublicationSigningSessions.status, 'pending'),
          ),
        )
        .returning();
      return claimed ? signingSessionFromRow(claimed) : undefined;
    });
  }

  async complete(sessionId: string): Promise<void> {
    await this.transition(sessionId, 'completed');
  }

  async markSecurityViolation(sessionId: string, code: string): Promise<void> {
    await this.transition(sessionId, 'security_violation', code);
  }

  async markFailed(sessionId: string, code: string): Promise<void> {
    await this.transition(sessionId, 'failed', code);
  }

  async getForOwner(
    sessionId: string,
    ownerId: string,
    videoId: string,
  ): Promise<StoredW3dsVideoPublicationSigningSession | undefined> {
    const [row] = await this.db
      .select()
      .from(w3dsVideoPublicationSigningSessions)
      .where(
        and(
          eq(w3dsVideoPublicationSigningSessions.id, sessionId),
          eq(w3dsVideoPublicationSigningSessions.ownerId, ownerId),
          eq(w3dsVideoPublicationSigningSessions.videoId, videoId),
        ),
      )
      .limit(1);
    return row ? signingSessionFromRow(row) : undefined;
  }

  private async transition(
    sessionId: string,
    status: Extract<
      W3dsVideoPublicationSigningStatus,
      'completed' | 'failed' | 'security_violation'
    >,
    errorCode?: string,
  ): Promise<void> {
    const now = new Date();
    const updated = await this.db
      .update(w3dsVideoPublicationSigningSessions)
      .set({
        status,
        ...(errorCode ? { errorCode } : {}),
        updatedAt: now,
      })
      .where(
        and(
          eq(w3dsVideoPublicationSigningSessions.id, sessionId),
          eq(w3dsVideoPublicationSigningSessions.status, 'verifying'),
        ),
      )
      .returning({ id: w3dsVideoPublicationSigningSessions.id });
    if (updated.length === 0) {
      throw new W3dsVideoPublicationSigningError(
        'Signing session is unavailable.',
        'invalid_session',
        401,
      );
    }
  }
}

function signingSessionFromRow(row: {
  id: string;
  videoId: string;
  ownerId: string;
  ownerEName: string;
  expiresAt: Date;
  status: W3dsVideoPublicationSigningStatus;
  errorCode: string | null;
}): StoredW3dsVideoPublicationSigningSession {
  return {
    id: row.id,
    videoId: row.videoId,
    ownerId: row.ownerId,
    ownerEName: row.ownerEName,
    expiresAt: row.expiresAt.getTime(),
    status: row.status,
    ...(row.errorCode ? { errorCode: row.errorCode } : {}),
  };
}

let sharedService: W3dsVideoPublicationSigningService | undefined;

export function getW3dsVideoPublicationSigningService(): W3dsVideoPublicationSigningService {
  if (!sharedService) {
    sharedService = new W3dsVideoPublicationSigningService({
      store: new PostgresW3dsVideoPublicationSigningStore(getW3dsDatabase()),
    });
  }
  return sharedService;
}

export function resetW3dsVideoPublicationSigningServiceForTests(): void {
  sharedService = undefined;
}
