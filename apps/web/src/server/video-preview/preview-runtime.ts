import { createEVaultVideoLibrary } from '../evault-video-library';
import {
  getVideoPreviewService as getOrCreateVideoPreviewService,
  resetVideoPreviewServiceForTests as resetShared,
} from './preview-service';

/** Production wiring. Loads the eVault library only when preview work starts. */
export function getVideoPreviewService() {
  return getOrCreateVideoPreviewService(createEVaultVideoLibrary());
}

export function resetVideoPreviewServiceForTests(): void {
  resetShared();
}
