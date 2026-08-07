import type {
  CreateVideoDraftInput,
  VideoCategory,
  VideoLanguage,
  VideoVisibility,
} from '@w3ds/types';
import { titleFromFileName } from './upload-constants';
import type { UploadDraft } from './upload-page';

/** Actionable copy when media upload needs a persisted draft first. */
export const DRAFT_REQUIRED_BEFORE_UPLOAD_MESSAGE =
  'Save your draft before uploading a video. Your details were kept — save the draft, then retry the upload.';

/** Distinct copy when creating/saving the draft fails before media transfer. */
export const DRAFT_SAVE_FAILED_MESSAGE =
  'Could not save your draft. Your file and details were kept — save the draft, then retry the upload.';

export type DraftUploadFailureKind = 'draft_required' | 'draft_save_failed' | 'media_upload_failed';

export class DraftUploadError extends Error {
  readonly kind: DraftUploadFailureKind;

  constructor(kind: DraftUploadFailureKind, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DraftUploadError';
    this.kind = kind;
  }
}

export function isDraftUploadError(error: unknown): error is DraftUploadError {
  return error instanceof DraftUploadError;
}

/** Title is the only server-required field for `POST /api/videos/drafts`. */
export function resolveDraftCreateTitle(fileName: string, draftTitle: string): string {
  return draftTitle.trim() || titleFromFileName(fileName) || 'Untitled video';
}

export type DraftCreateGateResult =
  | { ok: true; title: string }
  | { ok: false; reason: 'missing_required_fields' };

/**
 * Gate for auto-creating a durable draft before media upload.
 * Requires a selected file (for title derivation) and/or an explicit draft title.
 */
export function gateDraftCreateForUpload(input: {
  fileName: string | undefined;
  draftTitle: string;
}): DraftCreateGateResult {
  const explicitTitle = input.draftTitle.trim();
  if (explicitTitle) return { ok: true, title: explicitTitle };

  const fileName = input.fileName?.trim();
  if (!fileName) return { ok: false, reason: 'missing_required_fields' };

  return { ok: true, title: resolveDraftCreateTitle(fileName, '') };
}

/** Build the create-draft payload from the current form snapshot + resolved title. */
export function buildCreateDraftInput(
  title: string,
  draftSnapshot: UploadDraft,
): CreateVideoDraftInput {
  return {
    title,
    ...(draftSnapshot.description ? { description: draftSnapshot.description } : {}),
    ...(draftSnapshot.tags.length > 0 ? { tags: [...draftSnapshot.tags] } : {}),
    ...(draftSnapshot.category ? { category: draftSnapshot.category as VideoCategory } : {}),
    ...(draftSnapshot.language ? { language: draftSnapshot.language as VideoLanguage } : {}),
    ...(draftSnapshot.visibility
      ? { visibility: draftSnapshot.visibility as VideoVisibility }
      : {}),
    ...(draftSnapshot.thumbnailUrl ? { thumbnailUrl: draftSnapshot.thumbnailUrl } : {}),
  };
}
