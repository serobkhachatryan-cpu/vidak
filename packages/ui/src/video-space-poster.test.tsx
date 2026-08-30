import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  VideoSpacePoster,
  VideoSpaceProcessingPoster,
  VideoSpaceUnavailablePoster,
} from './video-space-poster';

describe('VideoSpacePoster', () => {
  it('never renders a video player with controls on a grid card', () => {
    const ready = renderToStaticMarkup(
      <VideoSpacePoster
        title="friends with hats"
        posterUrl="https://example.com/poster.jpg"
        state="ready"
        durationSeconds={12}
        visibilityLabel="Private"
        locked
      />,
    );
    const processing = renderToStaticMarkup(
      <VideoSpaceProcessingPoster
        title="IMG 1589"
        durationSeconds={8}
        visibilityLabel="Private"
        locked
      />,
    );
    const unavailable = renderToStaticMarkup(
      <VideoSpaceUnavailablePoster
        title="Call recording"
        durationSeconds={45}
        visibilityLabel="Private"
        locked
      />,
    );

    for (const markup of [ready, processing, unavailable]) {
      expect(markup).not.toContain('<video');
      expect(markup).not.toContain('controls');
    }
  });

  it('does not render a broken img for an unusable poster URL', () => {
    const markup = renderToStaticMarkup(
      <VideoSpacePoster
        title="IMG 1589"
        posterUrl="blob:https://vidak.example/abc"
        state="ready"
      />,
    );
    expect(markup).not.toContain('blob:');
    expect(markup).not.toContain('<img');
  });

  it('shows a skeleton while processing, not error copy', () => {
    const markup = renderToStaticMarkup(
      <VideoSpaceProcessingPoster
        title="friends with hats"
        durationSeconds={12}
        visibilityLabel="Private"
      />,
    );
    expect(markup).toContain('Preparing preview');
    expect(markup).not.toContain('Preview unavailable');
    expect(markup).toContain('0:12');
    expect(markup).toContain('Private');
  });

  it('uses a designed cover for true failure, not a broken image', () => {
    const markup = renderToStaticMarkup(
      <VideoSpaceUnavailablePoster
        title="friends with hats"
        durationSeconds={12}
        visibilityLabel="Private"
        locked
      />,
    );
    expect(markup).toContain('friends with hats');
    expect(markup).toContain('Preview unavailable');
    expect(markup).toContain('0:12');
    expect(markup).not.toContain('<img');
    expect(markup).not.toContain('<video');
  });

  it('gives call recordings a poster cover with duration and lock badge', () => {
    const markup = renderToStaticMarkup(
      <VideoSpacePoster
        title="Call recording"
        posterUrl="/api/evault/videos/grant/preview"
        state="ready"
        durationSeconds={90}
        visibilityLabel="Private"
        locked
      />,
    );
    expect(markup).toContain('1:30');
    expect(markup).toContain('Private');
    expect(markup).toContain('<img');
    expect(markup).not.toContain('<video');
    expect(markup).not.toContain('controls');
  });
});
