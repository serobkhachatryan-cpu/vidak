import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { vi } from 'vitest';
import * as creatorVideoModule from '../creator-video';
import { CreatorVideoService, PostgresCreatorVideoStore } from '../creator-video';
import type { W3dsDatabase } from '../db/client';
import * as schema from '../db/schema';
import * as mediaAssetModule from '../media-asset';
import { LocalDiskMediaStorage, MediaAssetService, PostgresMediaAssetStore } from '../media-asset';
import * as w3dsAuthModule from '../w3ds-auth';
import {
  type VerifiedW3dsIdentity,
  W3dsAuthService,
  type W3dsIdentityVerifier,
  w3dsAccessCookieName,
} from '../w3ds-auth';
import { PostgresW3dsAuthStore } from '../w3ds-auth-store';
import {
  PostgresW3dsAuthorizationSyncStore,
  W3dsAuthorizationSyncService,
} from '../w3ds-authorization-sync';

const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), '../../../drizzle');

const testJwtSecret = 'a development-only test secret with at least 32 characters';
const appOrigin = 'https://vidak.example';

export interface IntegrationHarness {
  mediaRoot: string;
  authService: W3dsAuthService;
  videoService: CreatorVideoService;
  mediaService: MediaAssetService;
  authorizationSync: W3dsAuthorizationSyncService;
  db: W3dsDatabase;
  client: PGlite;
  loginAs(identity: VerifiedW3dsIdentity): Promise<string>;
  bearerHeaders(accessToken: string): Record<string, string>;
  cookieHeaders(accessToken: string, withOrigin?: boolean): Record<string, string>;
  cleanup(): Promise<void>;
}

/**
 * Isolated integration harness: empty PGlite database + full migrations,
 * temporary media root, and wired Postgres-backed services. Never writes to
 * `.data/media` or a developer MEDIA_STORAGE_ROOT.
 */
export async function createIntegrationHarness(): Promise<IntegrationHarness> {
  const mediaRoot = await mkdtemp(join(tmpdir(), 'vidak-integration-media-'));
  const client = new PGlite();
  const pgliteDb = drizzle(client, { schema });
  await migrate(pgliteDb, { migrationsFolder });
  const db = pgliteDb as unknown as W3dsDatabase;

  const authStore = new PostgresW3dsAuthStore(db);
  const videoStore = new PostgresCreatorVideoStore(db);
  const mediaStore = new PostgresMediaAssetStore(db);
  const authorizationSyncStore = new PostgresW3dsAuthorizationSyncStore(db);

  // Per-login identity verifier; replaced by loginAs.
  let activeVerifier: W3dsIdentityVerifier = {
    verify: async () => {
      throw new Error('Call loginAs before completing an offer.');
    },
  };

  const authService = new W3dsAuthService({
    config: {
      platformName: 'vidak',
      registryBaseUrl: 'https://registry.example',
      jwtSecret: testJwtSecret,
    },
    store: authStore,
    identityVerifier: {
      verify: (input) => activeVerifier.verify(input),
    },
    now: () => 1_780_000_000_000,
  });

  const videoService = new CreatorVideoService({
    store: videoStore,
    resolveUser: async (accessToken) => (await authService.getSession(accessToken)).user,
  });

  const mediaService = new MediaAssetService({
    store: mediaStore,
    storage: new LocalDiskMediaStorage(mediaRoot),
    limits: {
      maxUploadBytes: 1024 * 1024,
      allowedContentTypes: ['video/mp4', 'video/webm', 'video/quicktime'],
    },
    resolveUser: async (accessToken) => (await authService.getSession(accessToken)).user,
  });

  // No official ACL client injected → fail-closed (`sdk_unavailable`), matching
  // production until `@w3ds/sdk` exposes authorization APIs. Never call a live remote.
  const authorizationSync = new W3dsAuthorizationSyncService({
    store: authorizationSyncStore,
    w3dsAuthorizationConfigured: true,
  });

  vi.spyOn(w3dsAuthModule, 'getW3dsAuthService').mockReturnValue(authService);
  vi.spyOn(creatorVideoModule, 'getCreatorVideoService').mockReturnValue(videoService);
  vi.spyOn(mediaAssetModule, 'getMediaAssetService').mockReturnValue(mediaService);

  async function loginAs(identity: VerifiedW3dsIdentity): Promise<string> {
    activeVerifier = {
      verify: vi.fn().mockResolvedValue(identity),
    };
    const offer = await authService.createOffer(appOrigin);
    await authService.completeOffer({
      w3id: identity.eName,
      session: offer.sessionId,
      signature: 'signature',
    });
    const cookieSession = await authService.getOfferSessionForCookie(offer.offerId);
    const accessToken = cookieSession.tokens.accessToken;
    if (!accessToken) throw new Error('Expected access token from development auth offer');
    return accessToken;
  }

  return {
    mediaRoot,
    authService,
    videoService,
    mediaService,
    authorizationSync,
    db,
    client,
    loginAs,
    bearerHeaders(accessToken: string) {
      return { Authorization: `Bearer ${accessToken}` };
    },
    cookieHeaders(accessToken: string, withOrigin = true) {
      return {
        Cookie: `${w3dsAccessCookieName}=${accessToken}`,
        ...(withOrigin ? { Origin: appOrigin } : {}),
      };
    },
    async cleanup() {
      vi.restoreAllMocks();
      creatorVideoModule.resetCreatorVideoServiceForTests();
      mediaAssetModule.resetMediaAssetServiceForTests();
      w3dsAuthModule.resetW3dsAuthServiceForTests();
      await client.close();
      await rm(mediaRoot, { recursive: true, force: true });
    },
  };
}

export function chunkedBody(bytes: Uint8Array, chunkSize: number): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.byteLength) {
        controller.close();
        return;
      }
      const end = Math.min(offset + chunkSize, bytes.byteLength);
      controller.enqueue(bytes.slice(offset, end));
      offset = end;
    },
  });
}

export { appOrigin, migrationsFolder, testJwtSecret, w3dsAccessCookieName };
