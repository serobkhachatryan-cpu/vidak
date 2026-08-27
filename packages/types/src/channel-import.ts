/** A supported external video platform that a creator may bring to Vidak. */
export const channelImportProviders = ['youtube', 'vimeo'] as const;

export type ChannelImportProvider = (typeof channelImportProviders)[number];

/** Public, secret-free capability information for the Settings experience. */
export interface ChannelImportProviderStatus {
  provider: ChannelImportProvider;
  label: string;
  /** True only when Vidak has the provider's server-only OAuth credentials. */
  available: boolean;
}

/** A source channel the signed-in creator has connected to Vidak. */
export interface ImportedChannel {
  id: string;
  provider: ChannelImportProvider;
  sourceChannelId: string;
  title: string;
  sourceUrl: string;
  thumbnailUrl?: string;
  /** Initial connection succeeds before the catalogue is synchronised. */
  status: 'connected' | 'syncing' | 'ready' | 'needs_reconnect' | 'failed';
  importedVideoCount: number;
  lastSyncedAt?: string;
}
