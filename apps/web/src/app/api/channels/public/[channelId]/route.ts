import { type NextRequest, NextResponse } from 'next/server';
import { CreatorVideoError, getCreatorVideoService } from '../../../../../server/creator-video';

export const runtime = 'nodejs';

type RouteContext = { params: Promise<{ channelId: string }> };

function errorResponse(error: unknown): NextResponse {
  if (error instanceof CreatorVideoError) {
    return NextResponse.json(
      { error: { code: error.code, message: error.message } },
      { status: error.status },
    );
  }
  return NextResponse.json(
    { error: { code: 'internal_error', message: 'Channel is unavailable.' } },
    { status: 500 },
  );
}

/**
 * GET /api/channels/public/:channelId
 * Anonymous safe channel projection. Never uses MockVideoApiClient.
 */
export async function GET(_request: NextRequest, context: RouteContext) {
  try {
    const { channelId } = await context.params;
    const channel = await getCreatorVideoService().getPublicChannel(channelId);
    return NextResponse.json({
      id: channel.id,
      handle: channel.handle,
      name: channel.name,
      ...(channel.description ? { description: channel.description } : {}),
      ...(channel.avatarUrl ? { avatarUrl: channel.avatarUrl } : {}),
      ...(channel.bannerUrl ? { bannerUrl: channel.bannerUrl } : {}),
      subscriberCount: channel.subscriberCount,
      videoCount: channel.videoCount,
      createdAt: channel.createdAt,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
