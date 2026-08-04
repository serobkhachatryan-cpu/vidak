import { type NextRequest, NextResponse } from 'next/server';
import {
  getW3dsAuthService,
  W3dsAuthError,
  type W3dsCallbackInput,
} from '../../../../server/w3ds-auth';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const input = (await request.json()) as W3dsCallbackInput;
    await getW3dsAuthService().completeOffer(input);
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof W3dsAuthError) {
      return NextResponse.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status },
      );
    }
    return NextResponse.json(
      { error: { code: 'validation_failed', message: 'Invalid authentication callback.' } },
      { status: 400 },
    );
  }
}
