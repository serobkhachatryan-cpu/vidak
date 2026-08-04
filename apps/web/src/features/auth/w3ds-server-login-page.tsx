import QRCode from 'qrcode';
import { getW3dsAuthService, type LoginOffer } from '../../server/w3ds-auth';

export interface W3dsServerLoginPageProps {
  publicOrigin: string;
  returnTo: string;
  offerId?: string;
}

function loginHref(returnTo: string, offerId?: string): string {
  const search = new URLSearchParams({ returnTo });
  if (offerId) search.set('offer', offerId);
  return `/login?${search.toString()}`;
}

function continueHref(offerId: string, returnTo: string): string {
  const search = new URLSearchParams({ returnTo });
  return `/api/auth/offer/${encodeURIComponent(offerId)}/continue?${search.toString()}`;
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
 * creates cookies and sends the user to their destination.
 */
export async function W3dsServerLoginPage({
  publicOrigin,
  returnTo,
  offerId,
}: W3dsServerLoginPageProps) {
  const offer = await resolveOffer(publicOrigin, offerId);
  const qrCode = await QRCode.toDataURL(offer.uri, {
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 256,
  });
  const pollUrl = continueHref(offer.offerId, returnTo);

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-lg items-center px-6 py-12">
      <meta httpEquiv="refresh" content={`2;url=${pollUrl}`} />
      <section className="w-full space-y-6 rounded-xl border border-border bg-surface p-6 shadow-sm">
        <div className="space-y-2">
          <h1 className="font-sans text-2xl font-semibold text-foreground">Sign in with eID</h1>
          <p className="font-sans text-sm text-muted-foreground">
            Scan the QR code with your eID wallet, or open the sign-in link on this device.
          </p>
          <p className="font-sans text-sm text-muted-foreground">
            Approve the request in your wallet. This page will finish signing you in automatically.
          </p>
        </div>

        <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start">
          <img
            src={qrCode}
            alt="QR code for eID sign-in"
            width={256}
            height={256}
            className="h-56 w-56 rounded-md border border-border bg-white p-2"
          />
          <div className="min-w-0 flex-1 space-y-3">
            <p className="font-sans text-sm font-medium text-foreground">Sign-in link</p>
            <a
              href={offer.uri}
              className="block break-all font-sans text-sm font-semibold text-primary hover:underline"
            >
              {offer.uri}
            </a>
            <p className="font-sans text-xs text-muted-foreground">
              Expires {new Date(offer.expiresAt).toLocaleTimeString()}
            </p>
            <p className="font-sans text-sm text-muted-foreground">Waiting for eID approval…</p>
          </div>
        </div>

        <a
          href={loginHref(returnTo)}
          className="block w-full rounded-md bg-primary px-4 py-2 text-center font-sans text-sm font-semibold text-primary-foreground hover:opacity-90"
        >
          Create a new eID request
        </a>
      </section>
    </main>
  );
}
