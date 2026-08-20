import QRCode from 'qrcode';
import { getW3dsAuthService, type LoginOffer } from '../../server/w3ds-auth';
import { buildLoginPath, buildOfferContinuePath } from './auth-session-handoff';
import { eidSignInCopy } from './eid-sign-in-copy';

export interface W3dsServerLoginPageProps {
  publicOrigin: string;
  returnTo: string;
  errorMessage?: string;
  offerId?: string;
}

async function resolveOffer(publicOrigin: string, offerId?: string): Promise<LoginOffer> {
  const service = getW3dsAuthService();
  if (offerId) {
    const existing = await service.getOfferForLogin(offerId, publicOrigin);
    if (existing) return existing;
  }
  return service.createOffer(publicOrigin);
}

/**
 * eID login that works even when the browser cannot use fetch or JavaScript.
 * A regular redirect polls the same server-side offer until the wallet callback
 * completes; `/continue` sets cookies and `/auth/handoff` verifies them with an
 * HTTP redirect to the destination.
 */
export async function W3dsServerLoginPage({
  publicOrigin,
  returnTo,
  errorMessage,
  offerId,
}: W3dsServerLoginPageProps) {
  const offer = await resolveOffer(publicOrigin, offerId);
  const qrCode = await QRCode.toDataURL(offer.uri, {
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 256,
  });
  const pollUrl = buildOfferContinuePath(offer.offerId, returnTo);

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-lg items-center px-6 py-12">
      <meta httpEquiv="refresh" content={`2;url=${pollUrl}`} />
      <section className="w-full space-y-6 rounded-xl border border-border bg-surface p-6 shadow-sm">
        <div className="space-y-2">
          <h1 className="font-sans text-2xl font-semibold text-foreground">
            {eidSignInCopy.heading}
          </h1>
          {errorMessage ? (
            <p className="font-sans text-sm text-destructive" role="alert">
              {errorMessage}
            </p>
          ) : null}
          <p className="font-sans text-sm text-muted-foreground">{eidSignInCopy.intro}</p>
          <p className="font-sans text-sm text-muted-foreground">{eidSignInCopy.approveHint}</p>
        </div>

        <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start">
          <img
            src={qrCode}
            alt={eidSignInCopy.qrAlt}
            width={256}
            height={256}
            className="h-56 w-56 rounded-md border border-border bg-white p-2"
          />
          <div className="min-w-0 flex-1 space-y-3">
            <p className="font-sans text-sm font-medium text-foreground">
              {eidSignInCopy.linkLabel}
            </p>
            <a
              href={offer.uri}
              className="block font-sans text-sm font-semibold text-primary hover:underline"
            >
              {eidSignInCopy.linkText}
            </a>
            <p className="font-sans text-xs text-muted-foreground">
              Expires {new Date(offer.expiresAt).toLocaleTimeString()}
            </p>
            <p className="font-sans text-sm text-muted-foreground">{eidSignInCopy.waiting}</p>
          </div>
        </div>

        <a
          href={buildLoginPath(returnTo)}
          className="block w-full rounded-md bg-primary px-4 py-2 text-center font-sans text-sm font-semibold text-primary-foreground hover:opacity-90"
        >
          {eidSignInCopy.newRequest}
        </a>
      </section>
    </main>
  );
}
