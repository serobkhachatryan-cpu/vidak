-- Frame candidates intentionally use fractional seconds. Preserve that value
-- rather than rejecting an otherwise valid derived preview during persistence.
ALTER TABLE "video_preview_assets"
  ALTER COLUMN "capture_seconds" TYPE double precision
  USING "capture_seconds"::double precision;
