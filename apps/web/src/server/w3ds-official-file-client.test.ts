import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  FakeW3dsOfficialFileClient,
  parseW3dsFileUri,
  requireW3dsOfficialFileClient,
  resolveW3dsOfficialFileClient,
  type W3dsOfficialFileClientError,
  W3dsOfficialFileHttpClient,
  type W3dsOfficialFileHttpTransport,
} from './w3ds-official-file-client';

function response(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Awaited<ReturnType<W3dsOfficialFileHttpTransport['request']>> {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name: string) {
        return headers[name.toLowerCase()] ?? headers[name] ?? null;
      },
    },
    async json() {
      return body;
    },
  };
}

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

  it('models the documented Registry resolution and uploadFile request through explicit transport injection', async () => {
    const request = vi
      .fn<W3dsOfficialFileHttpTransport['request']>()
      .mockResolvedValueOnce(
        response(200, { ename: '@creator.w3id', uri: 'https://evault.example/' }),
      )
      .mockResolvedValueOnce(
        response(200, {
          data: {
            uploadFile: {
              uri: 'w3ds://file?id=@creator.w3id/file_1',
              metaEnvelopeId: 'file_1',
              publicUrl: 'https://objects.example/files/file_1-avatar.png',
              errors: [],
            },
          },
        }),
      );
    const client = new W3dsOfficialFileHttpClient({
      registryBaseUrl: 'https://registry.example/',
      transport: { request },
    });

    await expect(
      client.uploadFile({
        ownerEName: '@creator.w3id',
        filename: 'avatar.png',
        contentType: 'image/png',
        content: 'data:image/png;base64,aGVsbG8=',
        acl: ['*'],
      }),
    ).resolves.toEqual({
      uri: 'w3ds://file?id=@creator.w3id/file_1',
      metaEnvelopeId: 'file_1',
      publicUrl: 'https://objects.example/files/file_1-avatar.png',
    });

    expect(request).toHaveBeenNthCalledWith(
      1,
      'https://registry.example/resolve?w3id=%40creator.w3id',
      {
        method: 'GET',
        headers: {},
      },
    );
    const [, upload] = request.mock.calls[1] ?? [];
    expect(upload).toMatchObject({
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-ENAME': '@creator.w3id',
      },
    });
    expect(request.mock.calls[1]?.[0]).toBe('https://evault.example/graphql');
    expect(JSON.parse(upload?.body ?? '{}')).toMatchObject({
      query: expect.stringContaining('mutation UploadFile($input: UploadFileInput!)'),
      variables: {
        input: {
          filename: 'avatar.png',
          contentType: 'image/png',
          content: 'data:image/png;base64,aGVsbG8=',
          acl: ['*'],
        },
      },
    });
  });

  it('dereferences only the documented manual 302 redirect with an explicit transport', async () => {
    const request = vi
      .fn<W3dsOfficialFileHttpTransport['request']>()
      .mockResolvedValueOnce(
        response(200, { ename: '@creator.w3id', uri: 'https://evault.example' }),
      )
      .mockResolvedValueOnce(
        response(302, undefined, { location: 'https://objects.example/files/file_1.png' }),
      );
    const client = new W3dsOfficialFileHttpClient({
      registryBaseUrl: 'https://registry.example',
      transport: { request },
    });

    await expect(client.dereferenceFileUri('w3ds://file?id=@creator.w3id/file_1')).resolves.toBe(
      'https://objects.example/files/file_1.png',
    );
    expect(request).toHaveBeenNthCalledWith(2, 'https://evault.example/files/file_1', {
      method: 'GET',
      headers: { 'X-ENAME': '@creator.w3id' },
      redirect: 'manual',
    });
  });

  it('fails closed on a malformed Registry payload, eVault GraphQL errors, or unsafe redirect', async () => {
    const registryMissingUri = new W3dsOfficialFileHttpClient({
      registryBaseUrl: 'https://registry.example',
      transport: { request: vi.fn().mockResolvedValue(response(200, {})) },
    });
    await expect(
      registryMissingUri.uploadFile({
        ownerEName: '@creator.w3id',
        filename: 'avatar.png',
        contentType: 'image/png',
        content: 'aGVsbG8=',
        acl: ['*'],
      }),
    ).rejects.toMatchObject({ code: 'registry_resolution_failed' });

    const graphQlError = new W3dsOfficialFileHttpClient({
      registryBaseUrl: 'https://registry.example',
      transport: {
        request: vi
          .fn<W3dsOfficialFileHttpTransport['request']>()
          .mockResolvedValueOnce(
            response(200, { ename: '@creator.w3id', uri: 'https://evault.example' }),
          )
          .mockResolvedValueOnce(response(200, { data: { uploadFile: { errors: [{}] } } })),
      },
    });
    await expect(
      graphQlError.uploadFile({
        ownerEName: '@creator.w3id',
        filename: 'avatar.png',
        contentType: 'image/png',
        content: 'aGVsbG8=',
        acl: ['*'],
      }),
    ).rejects.toMatchObject({ code: 'file_upload_failed' });

    const unsafeRedirect = new W3dsOfficialFileHttpClient({
      registryBaseUrl: 'https://registry.example',
      transport: {
        request: vi
          .fn<W3dsOfficialFileHttpTransport['request']>()
          .mockResolvedValueOnce(
            response(200, { ename: '@creator.w3id', uri: 'https://evault.example' }),
          )
          .mockResolvedValueOnce(response(302, undefined, { location: 'javascript:alert(1)' })),
      },
    });
    await expect(
      unsafeRedirect.dereferenceFileUri('w3ds://file?id=@creator.w3id/file_1'),
    ).rejects.toMatchObject({ code: 'file_dereference_failed' });
  });
});
