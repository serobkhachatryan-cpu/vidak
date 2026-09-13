import { NextRequest, NextResponse } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({ createRecordingConcatTicket: vi.fn() }));

vi.mock('../../../recordings/tickets/route', () => ({
  createRecordingConcatTicket: mocks.createRecordingConcatTicket,
}));

import { sharedVideoStreamAuthorizationReceiptCookieName } from '../../../../../../server/shared-video-authorization-receipt';
import { POST } from './route';

describe('stream-scoped continuous recording ticket route', () => {
  beforeEach(() => {
    mocks.createRecordingConcatTicket.mockReset();
    mocks.createRecordingConcatTicket.mockResolvedValue(new NextResponse(null, { status: 200 }));
  });

  it('passes segment zero’s isolated receipt rather than a later card’s legacy receipt', async () => {
    const receiptForA = 'receipt-for-stream-a';
    const response = await POST(
      new NextRequest('https://vidak.example/api/evault/videos/stream-a/recording-ticket', {
        method: 'POST',
        headers: {
          // Browser path matching sends A's stream cookie here. The API-wide
          // cookie may now hold B after another card was warmed.
          cookie: [
            `${sharedVideoStreamAuthorizationReceiptCookieName}=${receiptForA}`,
            '__Secure-vidak-shared-video-authorization=receipt-for-stream-b',
          ].join('; '),
          'content-type': 'application/json',
        },
        body: JSON.stringify({ streamIds: ['stream-a', 'stream-a-next'] }),
      }),
      { params: Promise.resolve({ streamId: 'stream-a' }) },
    );

    expect(response.status).toBe(200);
    expect(mocks.createRecordingConcatTicket).toHaveBeenCalledWith(expect.any(NextRequest), {
      initialAuthorizationReceipt: receiptForA,
      expectedFirstStreamId: 'stream-a',
    });
  });
});
