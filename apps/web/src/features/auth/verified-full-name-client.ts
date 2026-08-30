export interface VerifiedFullNameConsentStatus {
  eligible: boolean;
  prompt: boolean;
  sourceReady: boolean;
  decision: 'granted' | 'declined' | null;
  reason?: string;
}

export type VerifiedFullNameUiKind = 'hidden' | 'prompt' | 'unavailable' | 'profile';

export type VerifiedFullNameGrantResult =
  | { ok: true; user?: { displayName?: string } }
  | { ok: false; message: string; reason?: string };

const unavailableMessage = 'Your verified name is not available right now.';
const sessionMessage = 'Your sign-in needs to be refreshed before the verified name can be used.';

export function shouldCheckVerifiedFullName(input: {
  sessionProvider?: string | undefined;
  hasUser: boolean;
}): boolean {
  return input.hasUser && input.sessionProvider === 'w3ds';
}

export function messageForVerifiedFullNameStatus(
  status: number,
  code?: string,
  reason?: string,
): string {
  if (status === 401 || code === 'invalid_session') return sessionMessage;
  const key = reason ?? code;
  if (key === 'identity_mismatch' || code === 'identity_mismatch') {
    return 'This name does not match the signed-in identity.';
  }
  if (key === 'name_not_replaceable' || code === 'name_not_replaceable') {
    return 'Your public name was already set and was not changed.';
  }
  if (key === 'authorization_denied' || code === 'authorization_denied') {
    return 'Vidak is not allowed to read the verified name.';
  }
  if (key === 'parse_failure' || code === 'parse_failure') {
    return 'The verified name could not be read from your eID.';
  }
  if (
    key === 'source_unconfigured' ||
    key === 'source_unavailable' ||
    key === 'not_configured' ||
    key === 'remote_unavailable' ||
    code === 'not_configured' ||
    code === 'remote_unavailable'
  ) {
    return unavailableMessage;
  }
  if (key === 'name_unavailable' || code === 'name_unavailable') {
    return 'No verified name is stored with your eID yet.';
  }
  if (key === 'consent_required' || code === 'consent_required') {
    return 'Permission is required to use your verified name.';
  }
  return unavailableMessage;
}

export function verifiedFullNameUiFromGet(input: {
  ok: boolean;
  status: number;
  body?: Partial<VerifiedFullNameConsentStatus> & {
    error?: { code?: string; message?: string; reason?: string };
  };
}): {
  kind: VerifiedFullNameUiKind;
  status?: VerifiedFullNameConsentStatus;
  message?: string;
  reason?: string;
} {
  if (!input.ok) {
    const reason = input.body?.error?.reason ?? input.body?.error?.code;
    return {
      kind: 'unavailable',
      message: messageForVerifiedFullNameStatus(input.status, input.body?.error?.code, reason),
      ...(reason ? { reason } : {}),
    };
  }
  const status: VerifiedFullNameConsentStatus = {
    eligible: Boolean(input.body?.eligible),
    prompt: Boolean(input.body?.prompt),
    sourceReady: input.body?.sourceReady !== false,
    decision:
      input.body?.decision === 'granted' || input.body?.decision === 'declined'
        ? input.body.decision
        : null,
    ...(input.body?.reason ? { reason: input.body.reason } : {}),
  };
  if (!status.sourceReady) {
    return {
      kind: 'unavailable',
      status,
      message: unavailableMessage,
      reason: status.reason ?? 'source_unconfigured',
    };
  }
  if (status.prompt) return { kind: 'prompt', status };
  if (status.eligible) return { kind: 'profile', status };
  return { kind: 'hidden', status };
}

export async function fetchVerifiedFullNameConsent(fetcher: typeof fetch = fetch): Promise<{
  kind: VerifiedFullNameUiKind;
  status?: VerifiedFullNameConsentStatus;
  message?: string;
  reason?: string;
}> {
  const read = () =>
    fetcher('/api/auth/verified-full-name', { credentials: 'include', cache: 'no-store' });
  let response = await read();
  if (response.status === 401) {
    await fetcher('/api/auth/refresh', { method: 'POST', credentials: 'include' }).catch(
      () => undefined,
    );
    response = await read();
  }
  const body = (await response.json().catch(() => undefined)) as
    | (Partial<VerifiedFullNameConsentStatus> & {
        error?: { code?: string; reason?: string };
      })
    | undefined;
  return verifiedFullNameUiFromGet({
    ok: response.ok,
    status: response.status,
    ...(body ? { body } : {}),
  });
}

export async function submitVerifiedFullNameGrant(
  grant: boolean,
  fetcher: typeof fetch = fetch,
): Promise<VerifiedFullNameGrantResult> {
  const response = await fetcher('/api/auth/verified-full-name', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant }),
  });
  const body = (await response.json().catch(() => undefined)) as
    | {
        user?: { displayName?: string };
        error?: { code?: string; message?: string; reason?: string };
      }
    | undefined;
  if (!response.ok) {
    const reason = body?.error?.reason ?? body?.error?.code;
    return {
      ok: false,
      message: messageForVerifiedFullNameStatus(response.status, body?.error?.code, reason),
      ...(reason ? { reason } : {}),
    };
  }
  return { ok: true, ...(body?.user ? { user: body.user } : {}) };
}
