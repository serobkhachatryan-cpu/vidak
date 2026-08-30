import { type NextRequest, NextResponse } from 'next/server';
import { assertTrustedMutationOrigin } from '../../../../server/request-security';
import {
  getBearerToken,
  getW3dsAuthService,
  W3dsAuthError,
  w3dsAccessCookieName,
} from '../../../../server/w3ds-auth';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    assertTrustedMutationOrigin(request);
    const accessToken =
      getBearerToken(request.headers) ?? request.cookies.get(w3dsAccessCookieName)?.value;
    if (!accessToken) {
      throw new W3dsAuthError('Authentication is required.', 'invalid_session', 401);
    }
    const form = await request.formData().catch(() => undefined);
    const file = form?.get('file');
    if (file == null || typeof file === 'string') {
      throw new W3dsAuthError('Avatar image is required.', 'validation_failed', 400);
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const contentType = file.type || 'application/octet-stream';
    const filename =
      'name' in file && typeof file.name === 'string' && file.name.trim() ? file.name : 'avatar';
    const user = await getW3dsAuthService().uploadAvatar(accessToken, {
      bytes,
      contentType,
      filename,
    });
    return NextResponse.json(user);
  } catch (error) {
    if (error instanceof W3dsAuthError) {
      return NextResponse.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status },
      );
    }
    return NextResponse.json(
      { error: { code: 'internal_error', message: 'Authentication is unavailable.' } },
      { status: 500 },
    );
  }
}
