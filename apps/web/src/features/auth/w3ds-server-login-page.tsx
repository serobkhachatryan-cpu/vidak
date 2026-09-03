import QRCode from 'qrcode';
import { getW3dsAuthService, type LoginOffer } from '../../server/w3ds-auth';
import { buildLoginPath, buildOfferContinuePath } from './auth-session-handoff';
import { eidSignInCopy } from './eid-sign-in-copy';
import { W3dsServerOfferPoller } from './w3ds-server-offer-poller';

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
 * eID login with stable client-side polling. The no-JavaScript fallback keeps
 * a slower regular redirect so a wallet callback can still complete.
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
      <noscript>
        <meta httpEquiv="refresh" content={`5;url=${pollUrl}`} />
      </noscript>
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
            <W3dsServerOfferPoller offerId={offer.offerId} returnTo={returnTo} />
          </div>
        </div>

        <a
          href={buildLoginPath(returnTo)}
          className="block w-full rounded-md bg-primary px-4 py-2 text-center font-sans text-sm font-semibold text-primary-foreground hover:opacity-90"
        >
          {eidSignInCopy.newRequest}
        </a>
        <div className="flex justify-between gap-4 text-sm">
          <a href="/" className="font-semibold text-primary hover:underline">
            Watch public videos
          </a>
          <a href="/support" className="font-semibold text-primary hover:underline">
            Support
          </a>
        </div>
      </section>
    </main>
  );
}
