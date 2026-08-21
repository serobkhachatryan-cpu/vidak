import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  FakeW3dsOfficialFileClient,
  parseW3dsFileUri,
  requireW3dsOfficialFileClient,
  resolveW3dsOfficialFileClient,
  type W3dsOfficialFileClientError,
} from './w3ds-official-file-client';

describe('official File URI boundary', () => {
  it('remains unavailable in production and never resolves the test fake', () => {
    expect(resolveW3dsOfficialFileClient()).toMatchObject({ status: 'unavailable' });
    expect(() => requireW3dsOfficialFileClient()).toThrow(/unavailable/i);
  });

  it('creates and dereferences a File URI only through explicit test injection', async () => {
    const client = new FakeW3dsOfficialFileClient();
    const uploaded = await client.uploadFile({
      ownerEName: '@creator.w3id',
      filename: 'avatar.png',
      contentType: 'image/png',
      content: 'data:image/png;base64,aGVsbG8=',
      acl: ['*'],
    });

    expect(uploaded.uri).toBe('w3ds://file?id=@creator.w3id/file_fake_1');
    expect(parseW3dsFileUri(uploaded.uri)).toEqual({
      ownerEName: '@creator.w3id',
      metaEnvelopeId: 'file_fake_1',
    });
    await expect(client.dereferenceFileUri(uploaded.uri)).resolves.toBe(
      'https://files.invalid/file_fake_1/avatar.png',
    );
    expect(client.calls.map((call) => call.method)).toEqual(['uploadFile', 'dereferenceFileUri']);
  });

  it('rejects malformed content and never fabricates a File URI', async () => {
    const client = new FakeW3dsOfficialFileClient();
    await expect(
      client.uploadFile({
        ownerEName: '@creator.w3id',
        filename: 'avatar.png',
        contentType: 'image/png',
        content: 'data:image/png;base64,not base64',
        acl: ['*'],
      }),
    ).rejects.toMatchObject({
      code: 'invalid_content',
    } satisfies Partial<W3dsOfficialFileClientError>);
    expect(client.calls).toEqual([]);
  });
});
