import 'server-only';

import {
  createMeshengerVideoLibrary,
  createMeshengerVideoStreamId,
  type MeshengerLibrary,
  type MeshengerVideo,
  type MeshengerVideoKind,
  MeshengerVideoLibraryError,
  verifyMeshengerVideoStreamId,
} from './meshenger-video-library';
import { assembleVideoSpaceCatalogue } from './video-space/catalogue';
import { type InventoryCompleteness, inventoryCompletenessCopy } from './video-space/completeness';
import { documentedVideoSourceIds, documentedVideoSources } from './video-space/documented-sources';
import type { VideoSpaceAccessScope, VideoSpaceVisibility } from './video-space/visibility';

export type EVaultVideoAccessScope = VideoSpaceAccessScope;
export type EVaultVideoVisibility = VideoSpaceVisibility;
export type EVaultVideoKind = MeshengerVideoKind;
export type EVaultVideo = MeshengerVideo;
export type EVaultVideoLibraryResult = MeshengerLibrary;
export type EVaultInventoryCompleteness = InventoryCompleteness;
export {
  assembleVideoSpaceCatalogue,
  createMeshengerVideoStreamId as createEVaultVideoStreamId,
  documentedVideoSourceIds,
  documentedVideoSources,
  inventoryCompletenessCopy,
  MeshengerVideoLibraryError as EVaultVideoLibraryError,
  verifyMeshengerVideoStreamId as verifyEVaultVideoStreamId,
};

/**
 * Source-neutral authorised eVault catalogue.
 *
 * Adapters (see `video-space/documented-sources.ts`): W3DS File, File records,
 * call recordings, and video/circle messages already documented in this repo.
 * Inventory assembly lives in `video-space/catalogue.ts` (dedupe, visibility,
 * completeness). The eVault GraphQL reader stays in meshenger-video-library
 * and uses only documented `metaEnvelopes(filter: { ontologyId })` calls.
 */
export function createEVaultVideoLibrary(
  ...args: Parameters<typeof createMeshengerVideoLibrary>
): ReturnType<typeof createMeshengerVideoLibrary> {
  return createMeshengerVideoLibrary(...args);
}

export type EVaultVideoLibrary = ReturnType<typeof createEVaultVideoLibrary>;
export type { InventoryDiscovery, InventoryMetrics, InventoryScope } from './video-space/discovery';
