import 'server-only';

export type { VideoSpaceVisibility as EVaultVideoVisibility } from './video-space/visibility';
export type {
  EVaultVideoAccessScope,
  MeshengerLibrary as EVaultVideoLibraryResult,
  MeshengerVideo as EVaultVideo,
  MeshengerVideoKind as EVaultVideoKind,
} from './meshenger-video-library';
/**
 * Source-neutral boundary for Vidak's authorised eVault video catalogue.
 * The implementation recognises standard W3DS file records plus known call
 * and video-message metadata without exposing the source app.
 */
export {
  createMeshengerVideoLibrary as createEVaultVideoLibrary,
  createMeshengerVideoStreamId as createEVaultVideoStreamId,
  MeshengerVideoLibraryError as EVaultVideoLibraryError,
  verifyMeshengerVideoStreamId as verifyEVaultVideoStreamId,
} from './meshenger-video-library';
