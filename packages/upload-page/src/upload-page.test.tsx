import type { Video } from '@w3ds/types';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { emptyUploadDraft, UploadPage } from './upload-page';

const publishedVideo: Video = {
  id: 'video-new',
  channelId: 'channel-studio',
  title: 'Building a practical design system',
  description: 'A tour of the decisions that keep a design system useful.',
  thumbnailUrl: 'https://example.com/thumbnail.jpg',
  durationSeconds: 742,
  status: 'published',
  visibility: 'public',
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

  it('renders visibility options and publish confirmation summary', () => {
    const draft = {
      ...emptyUploadDraft(),
      title: 'Caching server state',
      description: 'Reliable client-side fetching',
      category: 'education' as const,
      language: 'en' as const,
      visibility: 'unlisted' as const,
      thumbnailUrl: 'https://example.com/thumb.jpg',
      tags: ['react'],
    };
    const visibility = renderToStaticMarkup(<UploadPage step="visibility" draft={draft} />);
    expect(visibility).toContain('role="radiogroup"');
    expect(visibility).toContain('Public');
    expect(visibility).toContain('Unlisted');
    expect(visibility).toContain('Private');

    const publish = renderToStaticMarkup(
      <UploadPage step="publish" draft={draft} fileName="cache.mp4" />,
    );
    expect(publish).toContain('Caching server state');
    expect(publish).toContain('Save draft');
    expect(publish).toContain('Publishing is not available yet');
    expect(publish).toContain('Unlisted');
  });

  it('renders the draft saved success state', () => {
    const { publishedAt: _publishedAt, ...draftVideoBase } = publishedVideo;
    void _publishedAt;
    const draftVideo: Video = { ...draftVideoBase, status: 'draft' };
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
    expect(markup).toContain('aria-label="Publish confirmation"');
    expect(markup).not.toContain('aria-label="Upload steps"');
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
