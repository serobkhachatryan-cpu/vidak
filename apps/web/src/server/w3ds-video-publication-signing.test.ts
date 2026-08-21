import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Video } from '@w3ds/types';
import { describe, expect, it, vi } from 'vitest';
import {
  InMemoryW3dsVideoPublicationSigningStore,
  W3dsVideoPublicationSigningService,
} from './w3ds-video-publication-signing';

vi.mock('server-only', () => ({}));

const owner = { id: 'owner-1', eName: '@owner.w3id' };
const draft = {
  id: 'video-1',
  title: 'A real consent action',
  status: 'draft',
} as Video;

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../..');

function listSourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      files.push(...listSourceFiles(path));
    } else if (
      /\.(ts|tsx)$/.test(entry) &&
      !entry.endsWith('.test.ts') &&
      !entry.endsWith('.test.tsx')
    ) {
      files.push(path);
    }
  }
  return files;
}

function createService(options?: { now?: () => number; sessionLifetimeMs?: number }) {
  const store = new InMemoryW3dsVideoPublicationSigningStore();
  const resolveUser = vi.fn().mockResolvedValue(owner);
  const getOwnedDraft = vi.fn().mockResolvedValue(draft);
  const verifySignature = vi.fn().mockResolvedValue({
    eName: owner.eName,
    eVaultId: 'vault-owner',
    eVaultUri: 'https://evault.example/owner',
  });
  const publishVerifiedVideo = vi.fn().mockResolvedValue({ ...draft, status: 'published' });
  const getOwnedVideo = vi.fn().mockResolvedValue({ ...draft, status: 'published' });
  const service = new W3dsVideoPublicationSigningService({
    store,
    resolveUser,
    getOwnedDraft,
    getOwnedVideo,
    verifySignature,
    publishVerifiedVideo,
    createId: () => 'session-1',
    now: options?.now ?? (() => 1_780_000_000_000),
    ...(options?.sessionLifetimeMs === undefined
      ? {}
      : { sessionLifetimeMs: options.sessionLifetimeMs }),
  });
  return {
    store,
    service,
    resolveUser,
    getOwnedDraft,
    getOwnedVideo,
    verifySignature,
    publishVerifiedVideo,
  };
}

describe('W3DS signed video publication', () => {
  it('creates a 15-minute w3ds://sign offer bound to the authenticated draft', async () => {
    const { service, store, resolveUser, getOwnedDraft } = createService();
    const offer = await service.createOffer({
      accessToken: 'access-token',
      videoId: draft.id,
      publicBaseUrl: 'https://vidak.example',
    });
    const uri = new URL(offer.qrData);
    const data = JSON.parse(
      Buffer.from(uri.searchParams.get('data') ?? '', 'base64').toString('utf8'),
    );

    expect(uri.protocol).toBe('w3ds:');
    expect(uri.hostname).toBe('sign');
    expect(uri.searchParams.get('session')).toBe('session-1');
    expect(uri.searchParams.get('redirect_uri')).toBe(
      'https://vidak.example/api/signing/video-publication/callback',
    );
    expect(data).toEqual({
      message: 'Publish video “A real consent action” on Vidak.',
      sessionId: 'session-1',
      videoId: draft.id,
    });
    expect(new Date(offer.expiresAt).getTime()).toBe(1_780_000_900_000);
    expect(resolveUser).toHaveBeenCalledWith('access-token');
    expect(getOwnedDraft).toHaveBeenCalledWith('access-token', draft.id);
    expect(store.get(offer.sessionId)).toMatchObject({
      videoId: draft.id,
      ownerId: owner.id,
      ownerEName: owner.eName,
      status: 'pending',
    });
  });

  it('verifies the exact session id and publishes only the bound draft once', async () => {
    const { service, store, verifySignature, publishVerifiedVideo } = createService();
    const offer = await service.createOffer({
      accessToken: 'access-token',
      videoId: draft.id,
      publicBaseUrl: 'https://vidak.example',
    });

    await expect(
      service.completeOffer({
        sessionId: offer.sessionId,
        signature: 'signature',
        w3id: owner.eName,
        message: offer.sessionId,
      }),
    ).resolves.toMatchObject({ id: draft.id, status: 'published' });
    expect(verifySignature).toHaveBeenCalledWith({
      w3id: owner.eName,
      signature: 'signature',
      payload: offer.sessionId,
    });
    expect(publishVerifiedVideo).toHaveBeenCalledWith({
      videoId: draft.id,
      ownerId: owner.id,
      ownerEName: owner.eName,
    });
    expect(store.get(offer.sessionId)).toMatchObject({ status: 'completed' });

    await expect(
      service.completeOffer({
        sessionId: offer.sessionId,
        signature: 'signature',
        w3id: owner.eName,
        message: offer.sessionId,
      }),
    ).rejects.toMatchObject({ code: 'invalid_session' });
    expect(publishVerifiedVideo).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the callback message or signer does not match the stored session', async () => {
    const { service, store, verifySignature, publishVerifiedVideo } = createService();
    const offer = await service.createOffer({
      accessToken: 'access-token',
      videoId: draft.id,
      publicBaseUrl: 'https://vidak.example',
    });

    await expect(
      service.completeOffer({
        sessionId: offer.sessionId,
        signature: 'signature',
        w3id: '@attacker.w3id',
        message: 'not-the-session',
      }),
    ).rejects.toMatchObject({ code: 'invalid_signature' });
    expect(verifySignature).not.toHaveBeenCalled();
    expect(publishVerifiedVideo).not.toHaveBeenCalled();
    expect(store.get(offer.sessionId)).toMatchObject({
      status: 'security_violation',
      errorCode: 'session_or_identity_mismatch',
    });
  });

  it('expires a pending session before it can verify or publish', async () => {
    let now = 1_780_000_000_000;
    const { service, store, verifySignature, publishVerifiedVideo } = createService({
      now: () => now,
      sessionLifetimeMs: 1,
    });
    const offer = await service.createOffer({
      accessToken: 'access-token',
      videoId: draft.id,
      publicBaseUrl: 'https://vidak.example',
    });
    now += 1;

    await expect(
      service.completeOffer({
        sessionId: offer.sessionId,
        signature: 'signature',
        w3id: owner.eName,
        message: offer.sessionId,
      }),
    ).rejects.toMatchObject({ code: 'invalid_session' });
    expect(store.get(offer.sessionId)).toMatchObject({ status: 'expired' });
    expect(verifySignature).not.toHaveBeenCalled();
    expect(publishVerifiedVideo).not.toHaveBeenCalled();
  });

  it('lets only the owner poll a completed offer and returns the completed local video', async () => {
    const { service, getOwnedVideo } = createService();
    const offer = await service.createOffer({
      accessToken: 'access-token',
      videoId: draft.id,
      publicBaseUrl: 'https://vidak.example',
    });
    await service.completeOffer({
      sessionId: offer.sessionId,
      signature: 'signature',
      w3id: owner.eName,
      message: offer.sessionId,
    });

    await expect(
      service.getOfferStatus({
        accessToken: 'access-token',
        sessionId: offer.sessionId,
        videoId: draft.id,
      }),
    ).resolves.toMatchObject({
      sessionId: offer.sessionId,
      videoId: draft.id,
      status: 'completed',
      video: { id: draft.id, status: 'published' },
    });
    expect(getOwnedVideo).toHaveBeenCalledWith('access-token', draft.id);
  });

  it('does not disclose an offer to another authenticated owner', async () => {
    const { service, store } = createService();
    const offer = await service.createOffer({
      accessToken: 'access-token',
      videoId: draft.id,
      publicBaseUrl: 'https://vidak.example',
    });
    const otherOwnerService = new W3dsVideoPublicationSigningService({
      store,
      resolveUser: async () => ({ id: 'other-owner', eName: '@other.w3id' }),
    });

    await expect(
      otherOwnerService.getOfferStatus({
        accessToken: 'other-token',
        sessionId: offer.sessionId,
        videoId: draft.id,
      }),
    ).rejects.toMatchObject({ code: 'not_found', status: 404 });
  });

  it('keeps signing protocol code out of browser packages and reuses the server verifier', () => {
    const browserRoots = [
      join(repoRoot, 'packages/api-client/src'),
      join(repoRoot, 'packages/hooks/src'),
      join(repoRoot, 'apps/web/src/features'),
    ];
    for (const root of browserRoots) {
      for (const file of listSourceFiles(root)) {
        const source = readFileSync(file, 'utf8');
        for (const forbidden of [
          'w3ds-video-publication-signing',
          '/api/signing/video-publication',
          'w3ds://sign',
          'RegistryW3dsIdentityVerifier',
          'W3DS_AUTH_JWT_SECRET',
        ]) {
          expect(source, `${file} must not contain ${forbidden}`).not.toContain(forbidden);
        }
      }
    }

    const serverSource = readFileSync(
      join(repoRoot, 'apps/web/src/server/w3ds-video-publication-signing.ts'),
      'utf8',
    );
    expect(serverSource).toMatch(/import ['"]server-only['"]/);
    expect(serverSource).toMatch(/getW3dsAuthService\(\)\.verifySignedPayload/);
    expect(serverSource).not.toMatch(/createVerify|signature-validator|createMetaEnvelope/);
    expect(serverSource).not.toMatch(/\bfetch\s*\(|\bhandleChange\s*\(|\buploadFile\b/);
    expect(serverSource).not.toMatch(/w3dsAdapterMappings|creatorChannels/);
  });
});
