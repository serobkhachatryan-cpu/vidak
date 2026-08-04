import type { DraftMediaAsset, Video } from '@w3ds/types';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DRAFT_REQUIRED_BEFORE_UPLOAD_MESSAGE } from './draft-before-upload';
import { resolveVideoContentType } from './resolve-video-content-type';
import { emptyUploadDraft, UploadPage } from './upload-page';

const mediaAsset: DraftMediaAsset = {
  id: 'asset-1',
  ownerId: 'user-1',
  videoId: 'draft-1',
  originalFilename: 'demo.mp4',
  contentType: 'video/mp4',
  byteSize: 1_024,
  uploadState: 'ready',
  createdAt: '2026-08-04T10:00:00.000Z',
  updatedAt: '2026-08-04T10:00:00.000Z',
};

const publishedPublicVideo: Video = {
  id: 'video-new',
  channelId: 'channel-studio',
  title: 'Building a practical design system',
  description: 'A tour of the decisions that keep a design system useful.',
  thumbnailUrl: 'https://example.com/thumbnail.jpg',
  durationSeconds: 742,
  status: 'published',
  visibility: 'public',
  publicVideoId: 'pub_design-system',
  category: 'education',
  language: 'en',
  publishedAt: '2026-08-04T10:00:00.000Z',
  createdAt: '2026-08-04T09:30:00.000Z',
  updatedAt: '2026-08-04T10:00:00.000Z',
  viewCount: 0,
  likeCount: 0,
  commentCount: 0,
  tags: ['design systems'],
};

const draftDetails = {
  ...emptyUploadDraft(),
  title: 'Caching server state',
  description: 'Reliable client-side fetching',
  category: 'education' as const,
  language: 'en' as const,
  visibility: 'unlisted' as const,
  thumbnailUrl: 'https://example.com/thumb.jpg',
  tags: ['react'],
};

describe('UploadPage', () => {
  it('renders an accessible stepper for the active upload step', () => {
    const markup = renderToStaticMarkup(<UploadPage step="details" />);
    expect(markup).toContain('aria-label="Upload steps"');
    expect(markup).toContain('aria-current="step"');
    expect(markup).toContain('Details');
    expect(markup).toContain('Title');
    expect(markup).toContain('Category');
    expect(markup).toContain('Language');
  });

  it('surfaces required field validation messaging on details', () => {
    const markup = renderToStaticMarkup(
      <UploadPage
        step="details"
        draft={emptyUploadDraft()}
        detailsErrors={{ title: 'Title is required.', category: 'Category is required.' }}
      />,
    );
    expect(markup).toContain('role="alert"');
    expect(markup).toContain('Title is required.');
    expect(markup).toContain('Category is required.');
    expect(markup).toContain('aria-invalid="true"');
  });

  it('renders upload progress metrics and cancel action', () => {
    const markup = renderToStaticMarkup(
      <UploadPage
        step="progress"
        fileName="demo.mp4"
        uploadStatus="uploading"
        progress={{
          percent: 42,
          bytesUploaded: 420,
          bytesTotal: 1000,
          bytesPerSecond: 100,
          remainingSeconds: 6,
        }}
        onCancelUpload={() => undefined}
      />,
    );
    expect(markup).toContain('role="progressbar"');
    expect(markup).toContain('aria-valuenow="42"');
    expect(markup).toContain('Cancel upload');
    expect(markup).toContain('demo.mp4');
  });

  it('renders draft review without ready media and disables publishing', () => {
    const visibility = renderToStaticMarkup(<UploadPage step="visibility" draft={draftDetails} />);
    expect(visibility).toContain('role="radiogroup"');
    expect(visibility).toContain('Public');
    expect(visibility).toContain('Unlisted');
    expect(visibility).toContain('Private');

    const publish = renderToStaticMarkup(
      <UploadPage
        step="publish"
        draft={draftDetails}
        fileName="cache.mp4"
        onSaveDraft={() => undefined}
        onPublish={() => undefined}
      />,
    );
    expect(publish).toContain('Caching server state');
    expect(publish).toContain('Save draft');
    expect(publish).toContain('Publish');
    expect(publish).toContain('Publishing is disabled until this draft has a ready media asset');
    expect(publish).toContain('Unlisted');
    expect(publish).toContain('disabled');
  });

  it('renders a publishable review when ready media is attached', () => {
    const markup = renderToStaticMarkup(
      <UploadPage
        step="publish"
        draft={{ ...draftDetails, visibility: 'public' }}
        fileName="cache.mp4"
        mediaAsset={mediaAsset}
        onPublish={() => undefined}
        onSaveDraft={() => undefined}
      />,
    );
    expect(markup).toContain('Media ready');
    expect(markup).toContain('Publish');
    expect(markup).toContain('Save draft');
    expect(markup).not.toContain('Publishing is disabled until this draft has a ready media asset');
  });

  it('renders publishing validation and route errors', () => {
    const markup = renderToStaticMarkup(
      <UploadPage
        step="publish"
        draft={draftDetails}
        mediaAsset={mediaAsset}
        publishError="Publish requires at least one ready media asset."
        onPublish={() => undefined}
      />,
    );
    expect(markup).toContain('role="alert"');
    expect(markup).toContain('Publish requires at least one ready media asset.');
  });

  it('renders the draft saved success state', () => {
    const {
      publicVideoId: _publicVideoId,
      publishedAt: _publishedAt,
      ...draftBase
    } = publishedPublicVideo;
    void _publicVideoId;
    void _publishedAt;
    const draftVideo: Video = {
      ...draftBase,
      status: 'draft',
    };
    const markup = renderToStaticMarkup(
      <UploadPage
        step="publish"
        draft={{
          ...emptyUploadDraft(),
          title: draftVideo.title,
          visibility: 'public',
        }}
        publishedVideo={draftVideo}
        onWatch={() => undefined}
        onUploadAnother={() => undefined}
      />,
    );
    expect(markup).toContain('Draft saved');
    expect(markup).toContain('not published');
    expect(markup).toContain('Upload another');
    expect(markup).not.toContain('Watch video');
    expect(markup).not.toContain('data-testid="share-link"');
    expect(markup).toContain('aria-label="Publish confirmation"');
  });

  it('renders published public share link without draft ids or storage keys', () => {
    const markup = renderToStaticMarkup(
      <UploadPage
        step="publish"
        draft={{ ...emptyUploadDraft(), title: publishedPublicVideo.title, visibility: 'public' }}
        publishedVideo={publishedPublicVideo}
        shareUrl="https://vidak.example/watch/pub_design-system"
        mediaAsset={mediaAsset}
        onWatch={() => undefined}
        onUnpublish={() => undefined}
        onUploadAnother={() => undefined}
      />,
    );
    expect(markup).toContain('Your video is live');
    expect(markup).toContain('Published · Public');
    expect(markup).toContain('data-testid="share-link"');
    expect(markup).toContain('/watch/pub_design-system');
    expect(markup).toContain('Watch video');
    expect(markup).toContain('Unpublish');
    expect(markup).not.toContain(publishedPublicVideo.id);
    expect(markup).not.toMatch(/storageKey|media_/i);
  });

  it('renders published unlisted share link and keeps private videos unshareable', () => {
    const unlisted = renderToStaticMarkup(
      <UploadPage
        step="publish"
        draft={{ ...emptyUploadDraft(), visibility: 'unlisted' }}
        publishedVideo={{
          ...publishedPublicVideo,
          visibility: 'unlisted',
          publicVideoId: 'pub_unlisted',
        }}
        shareUrl="https://vidak.example/watch/pub_unlisted"
        onUnpublish={() => undefined}
      />,
    );
    expect(unlisted).toContain('Published · Unlisted');
    expect(unlisted).toContain('/watch/pub_unlisted');

    const privatePublished = renderToStaticMarkup(
      <UploadPage
        step="publish"
        draft={{ ...emptyUploadDraft(), visibility: 'private' }}
        publishedVideo={{
          ...publishedPublicVideo,
          visibility: 'private',
          publicVideoId: 'pub_private',
        }}
        onUnpublish={() => undefined}
      />,
    );
    expect(privatePublished).toContain('Published · Private');
    expect(privatePublished).toContain('not shareable');
    expect(privatePublished).not.toContain('data-testid="share-link"');
    expect(privatePublished).not.toContain('/watch/pub_private');
  });

  it('renders cancelled upload recovery actions', () => {
    const markup = renderToStaticMarkup(
      <UploadPage
        step="progress"
        fileName="demo.mp4"
        uploadStatus="cancelled"
        uploadError="Upload cancelled."
        onRetryUpload={() => undefined}
      />,
    );
    expect(markup).toContain('Upload cancelled');
    expect(markup).toContain('Retry upload');
  });

  it('renders idle and validating upload states', () => {
    const idle = renderToStaticMarkup(<UploadPage step="progress" uploadStatus="idle" />);
    expect(idle).toContain('Ready to upload');

    const validating = renderToStaticMarkup(
      <UploadPage step="progress" fileName="demo.mp4" uploadStatus="validating" />,
    );
    expect(validating).toContain('Validating file format and size');
    expect(validating).toContain('demo.mp4');
  });

  it('renders upload success with attached asset metadata and remove action', () => {
    const markup = renderToStaticMarkup(
      <UploadPage
        step="progress"
        fileName="demo.mp4"
        uploadStatus="complete"
        progress={{
          percent: 100,
          bytesUploaded: 1024,
          bytesTotal: 1024,
          bytesPerSecond: 1024,
          remainingSeconds: 0,
        }}
        mediaAsset={mediaAsset}
        mediaPreviewSrc="/api/videos/drafts/draft-1/media/asset-1/content"
        onRemoveMedia={() => undefined}
      />,
    );
    expect(markup).toContain('Upload complete');
    expect(markup).toContain('Attached media');
    expect(markup).toContain('demo.mp4');
    expect(markup).toContain('video/mp4');
    expect(markup).toContain('Remove');
    expect(markup).toContain('/api/videos/drafts/draft-1/media/asset-1/content');
  });

  it('renders network error and retry affordance', () => {
    const markup = renderToStaticMarkup(
      <UploadPage
        step="progress"
        fileName="demo.mp4"
        uploadStatus="error"
        uploadError="Network connection lost."
        onRetryUpload={() => undefined}
      />,
    );
    expect(markup).toContain('Upload failed');
    expect(markup).toContain('Network connection lost.');
    expect(markup).toContain('Retry upload');
  });

  it('renders removing an attached asset on the details step', () => {
    const markup = renderToStaticMarkup(
      <UploadPage
        step="details"
        draft={{
          ...emptyUploadDraft(),
          title: 'Demo',
          category: 'education',
          language: 'en',
        }}
        mediaAsset={mediaAsset}
        isRemovingMedia
        onRemoveMedia={() => undefined}
      />,
    );
    expect(markup).toContain('Attached media');
    expect(markup).toContain('Removing…');
  });

  it('keeps draft-required messaging actionable for upload gating', () => {
    expect(DRAFT_REQUIRED_BEFORE_UPLOAD_MESSAGE).toMatch(/save your draft before uploading/i);
    expect(resolveVideoContentType({ name: 'clip.mov', type: '' })).toBe('video/quicktime');
    expect(resolveVideoContentType({ name: 'clip.mp4', type: 'video/mp4' })).toBe('video/mp4');
  });

  it('scopes the step heading id per page instance', () => {
    const markup = renderToStaticMarkup(
      <>
        <UploadPage step="details" />
        <UploadPage step="visibility" />
      </>,
    );
    expect(markup).toContain('aria-labelledby=');
    expect(markup).not.toContain('id="upload-step-heading"');
  });

  it('supports dark theme attribute for Storybook and shell reuse', () => {
    const markup = renderToStaticMarkup(<UploadPage step="select" theme="dark" />);
    expect(markup).toContain('data-theme="dark"');
    expect(markup).toContain('Drag and drop a video to upload');
    expect(markup).toContain('aria-label="Select a video file"');
  });
});
