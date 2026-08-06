/**
 * Types for Vidak-private adapter sync.
 * Projections are platform-local only — never MetaState-issued or public W3DS data.
 */

import type { Channel, Comment, Playlist, Video } from '@w3ds/types';

export type W3dsPrivateAdapterEntityType = 'channel' | 'video' | 'playlist' | 'comment';
export type W3dsPrivateAdapterSyncStatus = 'pending' | 'synced' | 'failed';
export type W3dsPrivateAdapterSyncOperation = 'upsert';
export type W3dsPrivateAdapterSyncOutcome = 'skipped' | 'synced' | 'failed' | 'unchanged';

export interface W3dsPrivateAdapterProjectionRecord {
  id: string;
  entityType: W3dsPrivateAdapterEntityType;
  localId: string;
  globalId: string;
  schemaId: string;
  ownerEName: string;
  ownership: 'vidak_private';
  catalogueVisibility: 'private';
  payload: Record<string, unknown>;
  payloadHash: string;
  mappingVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface W3dsPrivateAdapterOutboxRecord {
  id: string;
  entityType: W3dsPrivateAdapterEntityType;
  localId: string;
  operation: W3dsPrivateAdapterSyncOperation;
  syncStatus: W3dsPrivateAdapterSyncStatus;
  attemptCount: number;
  lastAttemptedAt?: string;
  lastSyncedAt?: string;
  failureReason?: string;
  correlationId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SyncChannelInput {
  channel: Channel;
  ownerEName: string;
  /** Defaults to channel.createdAt when product Channel omits updatedAt. */
  updatedAt?: string;
}

export interface SyncVideoInput {
  video: Video;
  ownerEName: string;
}

export interface SyncPlaylistInput {
  playlist: Playlist;
  ownerEName: string;
}

export interface SyncCommentInput {
  comment: Comment;
  ownerEName: string;
  /** Optional product visibility; ontology allows public|unlisted|private. */
  visibility?: 'public' | 'unlisted' | 'private';
}

export interface PrivateAdapterSyncResult {
  outcome: W3dsPrivateAdapterSyncOutcome;
  entityType: W3dsPrivateAdapterEntityType;
  localId: string;
  globalId?: string;
  schemaId?: string;
  ownership: 'vidak_private';
  catalogueVisibility: 'private';
  interoperablePublicW3ds: false;
  failureReason?: string;
  correlationId?: string;
}

export interface PrivateAdapterSyncStatusSnapshot {
  enabled: boolean;
  ontologyMode: 'vidak_private' | 'metastate_official' | 'unset';
  adapterConfigured: boolean;
  ownership: 'vidak_private';
  catalogueVisibility: 'private';
  interoperablePublicW3ds: false;
  metastateOntologyCalls: false;
  metastateEVaultWrites: false;
  remoteW3dsNetworkCalls: false;
}
