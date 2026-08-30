import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it } from 'vitest';
import { POST as publishVideo } from '../../app/api/videos/[videoId]/publish/route';
import { POST as uploadMedia } from '../../app/api/videos/drafts/[videoId]/media/route';
import { hashPublicViewerKey } from '../public-video-views';
import {
  chunkedBody,
  createIntegrationHarness,
  type IntegrationHarness,
} from './integration-harness';

describe('postgres public view counting', () => {
  let harness: IntegrationHarness | undefined;

  afterEach(async () => {
    await harness?.cleanup();
    harness = undefined;
  });

  it('joins the creator channel and counts concurrent views atomically', async () => {
    harness = await createIntegrationHarness();
    const ctx = harness;
    const accessToken = await ctx.loginAs({
      eName: '@ada.w3id',
      eVaultId: 'ev_ada',
      eVaultUri: 'https://evault.example/ada',
    });
    const session = await ctx.authService.getSession(accessToken);
    const draft = await ctx.videoService.createDraft(accessToken, {
      title: 'Production talk',
      visibility: 'public',
    });
    const payload = new TextEncoder().encode('view-count-bytes');
    const uploaded = await uploadMedia(
      new NextRequest('https://vidak.example/api/videos/drafts/x/media', {
        method: 'POST',
        body: chunkedBody(payload, 8),
        duplex: 'half',
        headers: {
          'Content-Type': 'video/mp4',
          'Content-Length': String(payload.byteLength),
          'X-Original-Filename': 'talk.mp4',
          ...ctx.bearerHeaders(accessToken),
        },
      }),
      { params: Promise.resolve({ videoId: draft.id }) },
    );
    expect(uploaded.status).toBe(201);

    const published = await publishVideo(
      new NextRequest(`https://vidak.example/api/videos/${draft.id}/publish`, {
        method: 'POST',
        headers: ctx.bearerHeaders(accessToken),
      }),
      { params: Promise.resolve({ videoId: draft.id }) },
    );
    expect(published.status).toBe(200);
    const publishedBody = (await published.json()) as { publicVideoId: string };
    const publicVideo = await ctx.videoService.getPublicVideo(publishedBody.publicVideoId);
    expect(publicVideo.channel?.id).toBe(draft.channelId);
    expect(publicVideo.channel?.name).toBe(session.user.displayName);
    expect(publicVideo.channel?.name).not.toBe('Unknown channel');
    expect(publicVideo.viewCount).toBe(0);

    const sameViewer = hashPublicViewerKey({
      pepper: 'test',
      publicVideoId: publishedBody.publicVideoId,
      clientAddress: '198.51.100.10',
      userAgent: 'VidakTest/1.0',
    });
    const duplicateBurst = await Promise.all(
      Array.from({ length: 8 }, () =>
        ctx.videoService.recordPublicView(publishedBody.publicVideoId, sameViewer),
      ),
    );
    expect(duplicateBurst.filter((result) => result.counted)).toHaveLength(1);
    expect(duplicateBurst.every((result) => result.video.viewCount === 1)).toBe(true);

    const distinctViewers = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        ctx.videoService.recordPublicView(
          publishedBody.publicVideoId,
          hashPublicViewerKey({
            pepper: 'test',
            publicVideoId: publishedBody.publicVideoId,
            clientAddress: `198.51.100.${20 + index}`,
            userAgent: 'VidakTest/1.0',
          }),
        ),
      ),
    );
    expect(distinctViewers.every((result) => result.counted)).toBe(true);
    const latest = await ctx.videoService.getPublicVideo(publishedBody.publicVideoId);
    expect(latest.viewCount).toBe(6);
    expect(latest.visibility).toBe('public');
  });
});
