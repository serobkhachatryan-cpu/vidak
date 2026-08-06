import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AuthUser } from '@w3ds/auth';
import {
  type CreateOfferRecordInput,
  type CreateSessionRecordInput,
  InMemoryW3dsAuthStore,
  type RotateSessionRecordInput,
  type StoredOffer,
  type StoredPlatformSession,
  type UpdateUserProfileRecordInput,
  type W3dsAuthStore,
} from './w3ds-auth-store';

/** Workspace-local path so Next route workers share e2e auth state. */
const statePath = join(process.cwd(), '.data', 'w3ds-e2e-auth-state.json');

/**
 * Cross-process e2e auth store. Next.js may handle continue/handoff/session on
 * different workers; a pure in-memory Map would not be shared between them.
 */
export class FilePersistedE2eW3dsAuthStore implements W3dsAuthStore {
  private readonly memory = new InMemoryW3dsAuthStore();
  private chain: Promise<unknown> = Promise.resolve();

  private async withState<T>(mutate: boolean, run: () => Promise<T>): Promise<T> {
    const execute = async () => {
      this.load();
      const result = await run();
      if (mutate) this.save();
      return result;
    };
    const result = this.chain.then(execute, execute);
    this.chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private load(): void {
    if (!existsSync(statePath)) return;
    try {
      const raw = readFileSync(statePath, 'utf8');
      this.memory.importSnapshot(
        JSON.parse(raw) as {
          offers: StoredOffer[];
          users: AuthUser[];
          sessions: StoredPlatformSession[];
        },
      );
    } catch {
      // Corrupt stub state — start empty for this request.
    }
  }

  private save(): void {
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, JSON.stringify(this.memory.exportSnapshot()), 'utf8');
  }

  createOffer(input: CreateOfferRecordInput) {
    return this.withState(true, () => this.memory.createOffer(input));
  }
  getOfferById(offerId: string) {
    return this.withState(false, () => this.memory.getOfferById(offerId));
  }
  getOfferBySessionId(sessionId: string) {
    return this.withState(false, () => this.memory.getOfferBySessionId(sessionId));
  }
  claimOfferForVerification(sessionId: string, now: number) {
    return this.withState(true, () => this.memory.claimOfferForVerification(sessionId, now));
  }
  completeOffer(offerId: string, platformSessionId: string) {
    return this.withState(true, () => this.memory.completeOffer(offerId, platformSessionId));
  }
  failOffer(offerId: string, errorCode: string) {
    return this.withState(true, () => this.memory.failOffer(offerId, errorCode));
  }
  markOfferExpired(offerId: string) {
    return this.withState(true, () => this.memory.markOfferExpired(offerId));
  }
  findUserByEName(eName: string) {
    return this.withState(false, () => this.memory.findUserByEName(eName));
  }
  findUserById(userId: string) {
    return this.withState(false, () => this.memory.findUserById(userId));
  }
  findOrCreateUser(user: AuthUser) {
    return this.withState(true, () => this.memory.findOrCreateUser(user));
  }
  updateUserProfile(input: UpdateUserProfileRecordInput) {
    return this.withState(true, () => this.memory.updateUserProfile(input));
  }
  createSession(input: CreateSessionRecordInput) {
    return this.withState(true, () => this.memory.createSession(input));
  }
  getSessionById(sessionId: string) {
    return this.withState(false, () => this.memory.getSessionById(sessionId));
  }
  listActiveSessionsByUserId(userId: string, now: number) {
    return this.withState(false, () => this.memory.listActiveSessionsByUserId(userId, now));
  }
  rotateSession(input: RotateSessionRecordInput) {
    return this.withState(true, () => this.memory.rotateSession(input));
  }
  revokeSession(sessionId: string) {
    return this.withState(true, () => this.memory.revokeSession(sessionId));
  }
}

export function resetFilePersistedE2eW3dsAuthStoreForTests(): void {
  try {
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, JSON.stringify({ offers: [], users: [], sessions: [] }), 'utf8');
  } catch {
    // ignore
  }
}
