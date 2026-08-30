export interface VerifiedFullNameConsentStatus {
  eligible: boolean;
  prompt: boolean;
  sourceReady: boolean;
  decision: 'granted' | 'declined' | null;
}

export type VerifiedFullNameUiKind = 'hidden' | 'prompt' | 'unavailable' | 'profile';

const unavailableMessage = 'Your verified name is not available right now.';
const sessionMessage = 'Your sign-in needs to be refreshed before the verified name can be used.';

export function shouldCheckVerifiedFullName(input: {
  sessionProvider?: string | undefined;
  hasUser: boolean;
}): boolean {
  return input.hasUser && input.sessionProvider === 'w3ds';
}

export function messageForVerifiedFullNameStatus(status: number, code?: string): string {
  if (status === 401 || code === 'invalid_session') return sessionMessage;
  if (code === 'identity_mismatch') {
    return 'This name does not match the signed-in identity.';
  }
  if (code === 'name_not_replaceable') {
    return 'Your public name was already set and was not changed.';
  }
  if (code === 'name_unavailable') {
    return 'No verified name is stored with your eID yet.';
  }
  if (code === 'consent_required') {
    return 'Permission is required to use your verified name.';
  }
  return unavailableMessage;
}

export function verifiedFullNameUiFromGet(input: {
  ok: boolean;
  status: number;
  body?: Partial<VerifiedFullNameConsentStatus> & { error?: { code?: string; message?: string } };
}): {
  kind: VerifiedFullNameUiKind;
  status?: VerifiedFullNameConsentStatus;
  message?: string;
} {
  if (!input.ok) {
    return {
      kind: 'unavailable',
      message: messageForVerifiedFullNameStatus(input.status, input.body?.error?.code),
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
  };
  if (!status.sourceReady) {
    return { kind: 'unavailable', status, message: unavailableMessage };
  }
  if (status.prompt) return { kind: 'prompt', status };
  if (status.eligible) return { kind: 'profile', status };
  return { kind: 'hidden', status };
}

export async function fetchVerifiedFullNameConsent(fetcher: typeof fetch = fetch): Promise<{
  kind: VerifiedFullNameUiKind;
  status?: VerifiedFullNameConsentStatus;
  message?: string;
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
    | (Partial<VerifiedFullNameConsentStatus> & { error?: { code?: string } })
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
): Promise<{ ok: true; user?: { displayName?: string } } | { ok: false; message: string }> {
  const response = await fetcher('/api/auth/verified-full-name', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant }),
  });
  const body = (await response.json().catch(() => undefined)) as
    | { user?: { displayName?: string }; error?: { code?: string; message?: string } }
    | undefined;
  if (!response.ok) {
    return {
      ok: false,
      message: messageForVerifiedFullNameStatus(response.status, body?.error?.code),
    };
  }
  return { ok: true, ...(body?.user ? { user: body.user } : {}) };
}
