import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import type { W3dsDatabase } from '../db/client';
import {
  InMemoryViewerChatGrantPointerStore,
  PostgresViewerChatGrantPointerStore,
  type ViewerChatGrantPointerStore,
} from './viewer-chat-grant-pointer-store';

const source = '@source.w3id';
const chatId = 'chat-123';
const viewer = '@viewer.w3id';

const pointerTableSql = `
  CREATE TABLE viewer_chat_grant_pointers (
    viewer_e_name text NOT NULL,
    source_e_name text NOT NULL,
    source_chat_id text NOT NULL,
    viewer_envelope_id text NOT NULL,
    envelope_hash text,
    state text NOT NULL,
    observed_at timestamp with time zone NOT NULL,
    invalidated_at timestamp with time zone,
    revoked_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL
  );
  CREATE UNIQUE INDEX viewer_chat_grant_pointers_identity_uidx
    ON viewer_chat_grant_pointers
    (viewer_e_name, source_e_name, source_chat_id, viewer_envelope_id);
  CREATE INDEX viewer_chat_grant_pointers_candidates_idx
    ON viewer_chat_grant_pointers
    (viewer_e_name, source_e_name, source_chat_id, state, observed_at);
`;

interface StoreHarness {
  store: ViewerChatGrantPointerStore;
  close(): Promise<void>;
}

async function memoryHarness(now: () => number, maxCandidates = 3): Promise<StoreHarness> {
  return {
    store: new InMemoryViewerChatGrantPointerStore({ now, maxCandidates }),
    close: async () => undefined,
  };
}

async function postgresHarness(now: () => number, maxCandidates = 3): Promise<StoreHarness> {
  const client = new PGlite();
  await client.exec(pointerTableSql);
  return {
    store: new PostgresViewerChatGrantPointerStore(drizzle(client) as unknown as W3dsDatabase, {
      now,
      maxCandidates,
    }),
    close: () => client.close(),
  };
}

const harnesses = [
  ['memory', memoryHarness],
  ['postgres', postgresHarness],
] as const;

describe.each(harnesses)('viewer Chat grant-pointer store (%s)', (_name, createHarness) => {
  let active: StoreHarness | undefined;

  afterEach(async () => {
    await active?.close();
    active = undefined;
  });

  it('keeps candidate pointers isolated per viewer and returns only pointer metadata', async () => {
    let now = 1_000;
    active = await createHarness(() => now);
    const { store } = active;
    const first = await store.upsert({
      viewerEName: 'Viewer.W3ID',
      sourceEName: 'SOURCE.W3ID',
      sourceChatId: chatId,
      viewerEnvelopeId: 'viewer-envelope-a',
      envelopeHash: 'sha256-a',
    });
    now += 1;
    await store.upsert({
      viewerEName: '@other-viewer.w3id',
      sourceEName: source,
      sourceChatId: chatId,
      viewerEnvelopeId: 'other-viewer-envelope',
    });

    expect(first).toEqual({
      viewerEName: viewer,
      sourceEName: source,
      sourceChatId: chatId,
      viewerEnvelopeId: 'viewer-envelope-a',
      envelopeHash: 'sha256-a',
      state: 'active',
      observedAt: 1_000,
      createdAt: 1_000,
      updatedAt: 1_000,
    });
    expect(first).not.toHaveProperty('mediaUrl');
    expect(first).not.toHaveProperty('authorization');

    const candidates = await store.listCandidates({
      viewerEName: viewer,
      sourceEName: source,
      sourceChatId: chatId,
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.viewerEnvelopeId).toBe('viewer-envelope-a');

    // Callers cannot mutate the persisted server-side record through a return value.
    const firstCandidate = candidates[0];
    if (!firstCandidate) throw new Error('Expected one viewer Chat grant pointer candidate.');
    firstCandidate.envelopeHash = 'mutated';
    const reread = await store.listCandidates({
      viewerEName: viewer,
      sourceEName: source,
      sourceChatId: chatId,
    });
    expect(reread[0]?.envelopeHash).toBe('sha256-a');
  });

  it('lists active candidates newest-first and bounds retained envelope IDs', async () => {
    let now = 1_000;
    active = await createHarness(() => now, 2);
    const { store } = active;
    for (const viewerEnvelopeId of ['envelope-1', 'envelope-2', 'envelope-3']) {
      await store.upsert({
        viewerEName: viewer,
        sourceEName: source,
        sourceChatId: chatId,
        viewerEnvelopeId,
      });
      now += 1_000;
    }

    const candidates = await store.listCandidates({
      viewerEName: viewer,
      sourceEName: source,
      sourceChatId: chatId,
      includeInactive: true,
      limit: 16,
    });
    expect(candidates.map((candidate) => candidate.viewerEnvelopeId)).toEqual([
      'envelope-3',
      'envelope-2',
    ]);
  });

  it('invalidates, revokes, and removes only the exact matching envelope ID', async () => {
    let now = 1_000;
    active = await createHarness(() => now);
    const { store } = active;
    const base = { viewerEName: viewer, sourceEName: source, sourceChatId: chatId };
    await store.upsert({ ...base, viewerEnvelopeId: 'older-envelope' });
    now += 1_000;
    await store.upsert({ ...base, viewerEnvelopeId: 'newer-envelope' });

    now += 1_000;
    await expect(
      store.markInvalid({ ...base, viewerEnvelopeId: 'older-envelope' }),
    ).resolves.toEqual(expect.objectContaining({ state: 'invalid', invalidatedAt: now }));
    await expect(store.listCandidates(base)).resolves.toEqual([
      expect.objectContaining({ viewerEnvelopeId: 'newer-envelope', state: 'active' }),
    ]);
    await expect(
      store.listCandidates({ ...base, includeInactive: true, limit: 3 }),
    ).resolves.toEqual([
      expect.objectContaining({ viewerEnvelopeId: 'newer-envelope', state: 'active' }),
      expect.objectContaining({ viewerEnvelopeId: 'older-envelope', state: 'invalid' }),
    ]);

    now += 1_000;
    await expect(store.revoke({ ...base, viewerEnvelopeId: 'newer-envelope' })).resolves.toEqual(
      expect.objectContaining({ state: 'revoked', revokedAt: now }),
    );
    // A stale invalidation cannot downgrade a more explicit revoked state.
    await expect(
      store.markInvalid({ ...base, viewerEnvelopeId: 'newer-envelope' }),
    ).resolves.toEqual(expect.objectContaining({ state: 'revoked' }));
    await expect(store.remove({ ...base, viewerEnvelopeId: 'older-envelope' })).resolves.toBe(true);
    await expect(store.remove({ ...base, viewerEnvelopeId: 'older-envelope' })).resolves.toBe(
      false,
    );
  });
});
