import { describe, expect, it, vi } from 'vitest';
import type { W3dsPlatformEVaultConfig } from './server-config';
import {
  ensureW3dsPlatformEVault,
  InMemoryW3dsPlatformEVaultStore,
  RegistryPlatformEVaultClient,
  type W3dsPlatformEVaultRemoteClient,
  w3dsPlatformEVaultLocalId,
  w3dsPlatformProfileOntology,
} from './w3ds-platform-evault';

const platformEVaultConfig: W3dsPlatformEVaultConfig = {
  provisionerBaseUrl: 'https://provisioner.example.com',
  verificationId: 'provision-only-secret',
  profile: {
    platformName: 'vidak',
    displayName: 'Vidak',
    description: 'Decentralized video publishing',
    version: '1.0.0',
    url: 'https://vidak.example',
    logoUrl: 'https://vidak.example/logo.png',
    category: 'Social',
  },
};

describe('W3DS platform eVault bootstrap', () => {
  it('uses only the documented entropy, provisioner, and eVault endpoints', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      calls.push({ url, ...(init ? { init } : {}) });
      if (url === 'https://registry.example.com/entropy') {
        return Response.json({ token: 'registry-entropy' });
      }
      if (url === 'https://provisioner.example.com/provision') {
        return Response.json({
          success: true,
          w3id: '@vidak.w3id',
          uri: 'https://evault.example.com',
        });
      }
      if (url === 'https://evault.example.com/graphql') {
        return Response.json({ data: { storeMetaEnvelope: { id: 'profile_1' } } });
      }
      return new Response(null, { status: 404 });
    };
    const client = new RegistryPlatformEVaultClient({
      registryBaseUrl: 'https://registry.example.com',
      provisionerBaseUrl: platformEVaultConfig.provisionerBaseUrl,
      fetcher,
    });

    const provisioned = await client.provision({
      verificationId: platformEVaultConfig.verificationId,
    });
    await client.writePlatformProfile({
      eName: provisioned.eName,
      eVaultUri: provisioned.eVaultUri,
      profile: platformEVaultConfig.profile,
      now: Date.UTC(2026, 7, 5),
    });

    expect(calls.map((call) => call.url)).toEqual([
      'https://registry.example.com/entropy',
      'https://provisioner.example.com/provision',
      'https://evault.example.com/graphql',
    ]);
    expect(JSON.parse(String(calls[1]?.init?.body))).toMatchObject({
      registryEntropy: 'registry-entropy',
      verificationId: 'provision-only-secret',
    });
    expect(JSON.parse(String(calls[1]?.init?.body))).not.toHaveProperty('publicKey');
    expect(calls[2]?.init?.headers).toMatchObject({ 'X-ENAME': '@vidak.w3id' });
    expect(JSON.parse(String(calls[2]?.init?.body))).toMatchObject({
      variables: {
        input: {
          ontology: w3dsPlatformProfileOntology,
          acl: ['*'],
          payload: {
            platformName: 'vidak',
            ename: '@vidak.w3id',
            isActive: true,
            isArchived: false,
          },
        },
      },
    });
  });

  it('uses the persisted mapping before making another provisioning request', async () => {
    const store = new InMemoryW3dsPlatformEVaultStore();
    await store.createIfAbsent({
      eName: '@vidak.w3id',
      eVaultUri: 'https://evault.example.com/',
      profile: platformEVaultConfig.profile,
      now: 1,
    });
    const remoteClient: W3dsPlatformEVaultRemoteClient = {
      provision: vi.fn(),
      writePlatformProfile: vi.fn(),
    };

    const record = await ensureW3dsPlatformEVault({
      registryBaseUrl: 'https://registry.example.com',
      platformEVault: platformEVaultConfig,
      store,
      remoteClient,
    });

    expect(record.id).toBe(w3dsPlatformEVaultLocalId);
    expect(remoteClient.provision).not.toHaveBeenCalled();
    expect(remoteClient.writePlatformProfile).not.toHaveBeenCalled();
  });
});
