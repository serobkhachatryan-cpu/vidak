import type { NextRequest } from 'next/server';
import { sharedVideoStreamAuthorizationReceiptCookieName } from '../../../../../../server/shared-video-authorization-receipt';
import { createRecordingConcatTicket } from '../../../recordings/tickets/route';

export const runtime = 'nodejs';

/**
 * Issues a continuous-recording ticket beneath segment zero's eVault route.
 * The browser therefore sends that stream's HttpOnly, Path-isolated receipt
 * even when another grid card was warmed later. The shared ticket issuer
 * verifies the receipt against this exact first stream before retaining it.
 */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ streamId: string }> },
) {
  const { streamId } = await context.params;
  const initialAuthorizationReceipt = request.cookies.get(
    sharedVideoStreamAuthorizationReceiptCookieName,
  )?.value;
  return createRecordingConcatTicket(request, {
    ...(initialAuthorizationReceipt ? { initialAuthorizationReceipt } : {}),
    expectedFirstStreamId: streamId,
  });
}
