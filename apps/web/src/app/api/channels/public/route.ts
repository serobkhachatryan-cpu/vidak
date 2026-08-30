import { type NextRequest, NextResponse } from 'next/server';
import { CreatorVideoError, getCreatorVideoService } from '../../../../server/creator-video';

export const runtime = 'nodejs';

function errorResponse(error: unknown): NextResponse {
  if (error instanceof CreatorVideoError) {
    return NextResponse.json(
      { error: { code: error.code, message: error.message } },
      { status: error.status },
    );
  }
  return NextResponse.json(
    { error: { code: 'internal_error', message: 'Channels are unavailable.' } },
    { status: 500 },
  );
}

/**
 * GET /api/channels/public
 * Anonymous discovery of creator channels that have at least one public video.
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = request.nextUrl;
    const cursor = searchParams.get('cursor') ?? undefined;
    const query = searchParams.get('q') ?? undefined;
    const limitParam = searchParams.get('limit');
    const limit =
      limitParam !== null && limitParam !== '' && /^\d+$/.test(limitParam)
        ? Number(limitParam)
        : undefined;
    const page = await getCreatorVideoService().listPublicChannels({
      ...(cursor ? { cursor } : {}),
      ...(limit !== undefined ? { limit } : {}),
      ...(query ? { query } : {}),
    });
    return NextResponse.json({
      ...page,
      items: page.items.map((channel) => ({
        id: channel.id,
        ownerId: channel.ownerId,
        handle: channel.handle,
        name: channel.name,
        ...(channel.description ? { description: channel.description } : {}),
        ...(channel.avatarUrl ? { avatarUrl: channel.avatarUrl } : {}),
        ...(channel.bannerUrl ? { bannerUrl: channel.bannerUrl } : {}),
        subscriberCount: channel.subscriberCount,
        videoCount: channel.videoCount,
        createdAt: channel.createdAt,
      })),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
