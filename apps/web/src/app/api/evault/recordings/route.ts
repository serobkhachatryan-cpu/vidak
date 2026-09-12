import { type NextRequest, NextResponse } from 'next/server';
import {
  createEVaultVideoLibrary,
  EVaultVideoLibraryError,
} from '../../../../server/evault-video-library';
import {
  issueRecordingConcatTicket,
  parseRecordingStreamIds,
  RecordingConcatTicketError,
} from '../../../../server/recording-concat-ticket';
import {
  SharedVideoAuthorizationReceiptConfigurationError,
  sharedVideoAuthorizationReceiptCookieName,
  verifySharedVideoAuthorizationReceipt,
} from '../../../../server/shared-video-authorization-receipt';
import {
  getBearerToken,
  getW3dsAuthService,
  W3dsAuthError,
  w3dsAccessCookieName,
} from '../../../../server/w3ds-auth';

export const runtime = 'nodejs';

/**
 * Compatibility bridge for a browser tab that still has the old player
 * bundle. New playback creates the ticket with POST, which keeps all sealed
 * stream grants out of the request URL. This redirect likewise avoids eager
 * source resolution before the first byte of a continuous recording.
 */
export async function GET(request: NextRequest) {
  try {
    const accessToken =
      getBearerToken(request.headers) ?? request.cookies.get(w3dsAccessCookieName)?.value;
    if (!accessToken)
      throw new W3dsAuthError('Authentication is required.', 'invalid_session', 401);
    const session = await getW3dsAuthService().getSession(accessToken);
    const streamIds = parseRecordingStreamIds(request.nextUrl.searchParams.getAll('stream'));
    const library = createEVaultVideoLibrary();
    // A recording ticket deliberately carries every segment, but startup must
    // not wait for source authorization of future segments. The stream route
    // resolves each later segment only when ffmpeg reaches it. Besides making
    // a long recording start promptly, this preserves its single continuous
    // output rather than turning authorization latency into a perceived split.
    const submittedFirstStreamId = streamIds[0];
    if (!submittedFirstStreamId) {
      throw new RecordingConcatTicketError(
        'This recording does not have a valid set of sources.',
        'invalid_recording',
        400,
      );
    }
    const firstStreamId = await validateOrRenewStream(
      library,
      session.user,
      submittedFirstStreamId,
    );
    const ticketStreamIds = [firstStreamId, ...streamIds.slice(1)];
    const initialAuthorizationReceipt = firstStreamId
      ? verifiedInitialAuthorizationReceipt(request, session.user.eName, firstStreamId)
      : undefined;
    const { playbackPath } = initialAuthorizationReceipt
      ? await issueRecordingConcatTicket(
          session.user,
          ticketStreamIds,
          undefined,
          undefined,
          undefined,
          { initialAuthorizationReceipt },
        )
      : await issueRecordingConcatTicket(session.user, ticketStreamIds);
    const response = NextResponse.redirect(new URL(playbackPath, request.url), 307);
    response.headers.set('Cache-Control', 'private, no-store, max-age=0');
    response.headers.set('Referrer-Policy', 'no-referrer');
    response.headers.set('X-Content-Type-Options', 'nosniff');
    return response;
  } catch (error) {
    return errorResponse(error);
  }
}

function verifiedInitialAuthorizationReceipt(
  request: NextRequest,
  viewerEName: string,
  streamId: string,
): string | undefined {
  const receipt = request.cookies.get(sharedVideoAuthorizationReceiptCookieName)?.value;
  if (!receipt) return undefined;
  try {
    return verifySharedVideoAuthorizationReceipt({ receipt, viewerEName, streamId })
      ? receipt
      : undefined;
  } catch (error) {
    if (error instanceof SharedVideoAuthorizationReceiptConfigurationError) return undefined;
    throw error;
  }
}

async function validateOrRenewStream(
  library: ReturnType<typeof createEVaultVideoLibrary>,
  user: Parameters<ReturnType<typeof createEVaultVideoLibrary>['inspectBoundStream']>[0],
  streamId: string,
): Promise<string> {
  try {
    library.inspectBoundStream(user, streamId);
    return streamId;
  } catch (error) {
    if (!(error instanceof EVaultVideoLibraryError) || error.code !== 'stream_expired') throw error;
    const renewed = await library.renewPlayableStream(user, streamId);
    library.inspectBoundStream(user, renewed);
    return renewed;
  }
}

function errorResponse(error: unknown): NextResponse {
  const known =
    error instanceof EVaultVideoLibraryError ||
    error instanceof W3dsAuthError ||
    error instanceof RecordingConcatTicketError;
  const status = known ? error.status : 500;
  const code = known ? error.code : 'recording_unavailable';
  const message = known ? error.message : 'This recording cannot be opened.';
  const response = NextResponse.json({ error: { code, message } }, { status });
  response.headers.set('Cache-Control', 'private, no-store, max-age=0');
  response.headers.set('Referrer-Policy', 'no-referrer');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  return response;
}
