import { describe, expect, it } from 'vitest';
import { resolveVideoSpaceTitle, titleFromFilename } from './titles';

describe('video space titles', () => {
  it('prefers explicit title and caption over filename', () => {
    expect(
      resolveVideoSpaceTitle({
        title: 'Launch recap',
        caption: 'Caption wins when title missing',
        filename: 'launch.mp4',
      }),
    ).toBe('Launch recap');
    expect(
      resolveVideoSpaceTitle({
        caption: 'Behind the scenes',
        filename: 'bts.mov',
      }),
    ).toBe('Behind the scenes');
  });

  it('humanizes filenames without extensions', () => {
    expect(titleFromFilename('my_cool-video.mp4')).toBe('My Cool Video');
    expect(
      resolveVideoSpaceTitle({
        filename: 'Studio take.mp4',
        kind: 'file',
      }),
    ).toBe('Studio Take');
  });

  it('falls back to message text and conversation titles', () => {
    expect(
      resolveVideoSpaceTitle({
        messageText: 'Quick update from the road',
        kind: 'video-message',
      }),
    ).toBe('Quick update from the road');
    expect(
      resolveVideoSpaceTitle({
        conversationTitle: 'Design sync',
        createdAt: '2026-08-24T12:00:00.000Z',
        kind: 'call-recording',
      }),
    ).toMatch(/^Design sync · /);
  });

  it('uses Untitled video as the final fallback', () => {
    expect(resolveVideoSpaceTitle({ kind: 'file' })).toBe('Untitled video');
  });
});
