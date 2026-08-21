'use client';

import type { Video } from '@w3ds/types';
import { Button, Text } from '@w3ds/ui';
import { UploadPageData, type UploadPageDataProps } from '@w3ds/upload-page';
import { useCallback, useEffect, useRef, useState } from 'react';
import { SignInQr } from '../auth/sign-in-qr';

const pollIntervalMs = 2_500;

interface SigningOffer {
  sessionId: string;
  qrData: string;
  expiresAt: string;
  videoId: string;
}

interface SigningOfferStatus {
  sessionId: string;
  videoId: string;
  status: 'pending' | 'verifying' | 'completed' | 'expired' | 'failed' | 'security_violation';
  expiresAt: string;
  video?: Video;
}

interface PendingPublication {
  resolve(video: Video): void;
  reject(error: Error): void;
}

function genericPublicationError(): Error {
  return new Error('We could not complete the signed publication. Please try again.');
}

function isSigningOffer(value: unknown): value is Omit<SigningOffer, 'videoId'> {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.sessionId === 'string' &&
    typeof candidate.qrData === 'string' &&
    typeof candidate.expiresAt === 'string'
  );
}

function isSigningOfferStatus(value: unknown): value is SigningOfferStatus {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.sessionId === 'string' &&
    typeof candidate.videoId === 'string' &&
    typeof candidate.status === 'string' &&
    typeof candidate.expiresAt === 'string'
  );
}

/**
 * The browser treats the offer as opaque display data. It creates and polls
 * same-origin product routes only; W3DS URI construction and verification stay
 * in server-only modules and the wallet callback.
 */
export function SignedVideoPublicationUploadPage({
  publishApproval: _publishApproval,
  publishActionLabel: _publishActionLabel,
  requestPublishApproval: _requestPublishApproval,
  ...props
}: UploadPageDataProps) {
  void _publishApproval;
  void _publishActionLabel;
  void _requestPublishApproval;
  const [offer, setOffer] = useState<SigningOffer>();
  const pendingRef = useRef<PendingPublication | undefined>(undefined);

  const clearPending = useCallback((error?: Error) => {
    const pending = pendingRef.current;
    pendingRef.current = undefined;
    if (error) pending?.reject(error);
  }, []);

  const requestPublishApproval = useCallback(
    async (draft: Video): Promise<Video> => {
      clearPending(genericPublicationError());
      setOffer(undefined);

      const response = await fetch(`/api/videos/${encodeURIComponent(draft.id)}/publish/signing`, {
        method: 'POST',
        credentials: 'same-origin',
      });
      if (!response.ok) throw genericPublicationError();
      const body: unknown = await response.json();
      if (!isSigningOffer(body)) throw genericPublicationError();

      setOffer({ ...body, videoId: draft.id });
      return new Promise<Video>((resolve, reject) => {
        pendingRef.current = { resolve, reject };
      });
    },
    [clearPending],
  );

  useEffect(() => {
    if (!offer) return;
    let cancelled = false;

    const finish = (error?: Error) => {
      if (cancelled) return;
      clearPending(error);
      setOffer(undefined);
    };

    const poll = async () => {
      try {
        if (new Date(offer.expiresAt).getTime() <= Date.now()) {
          finish(new Error('This signing request expired. Start a new signed publication.'));
          return;
        }
        const response = await fetch(
          `/api/videos/${encodeURIComponent(offer.videoId)}/publish/signing/${encodeURIComponent(offer.sessionId)}`,
          { cache: 'no-store', credentials: 'same-origin' },
        );
        if (!response.ok) {
          finish(genericPublicationError());
          return;
        }
        const body: unknown = await response.json();
        if (!isSigningOfferStatus(body) || body.sessionId !== offer.sessionId) {
          finish(genericPublicationError());
          return;
        }
        if (body.status === 'completed' && body.video) {
          const pending = pendingRef.current;
          pendingRef.current = undefined;
          pending?.resolve(body.video);
          if (!cancelled) setOffer(undefined);
          return;
        }
        if (
          body.status === 'expired' ||
          body.status === 'failed' ||
          body.status === 'security_violation'
        ) {
          finish(
            new Error('This signing request did not complete. Start a new signed publication.'),
          );
        }
      } catch {
        finish(genericPublicationError());
      }
    };

    void poll();
    const timer = setInterval(() => {
      void poll();
    }, pollIntervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [clearPending, offer]);

  useEffect(() => {
    return () => clearPending(genericPublicationError());
  }, [clearPending]);

  return (
    <UploadPageData
      {...props}
      requestPublishApproval={requestPublishApproval}
      publishActionLabel="Sign & publish"
      {...(offer
        ? {
            publishApproval: (
              <div
                className="rounded-md border border-primary/30 bg-primary/5 p-4"
                data-testid="signed-publication-offer"
              >
                <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start">
                  <SignInQr value={offer.qrData} alt="QR code to approve video publication" />
                  <div className="min-w-0 flex-1 space-y-2">
                    <Text className="font-semibold">Approve publication in your eID Wallet</Text>
                    <Text size="sm" tone="muted">
                      Scan the QR code or open the approval link. This one-time request expires at{' '}
                      {new Date(offer.expiresAt).toLocaleTimeString()}.
                    </Text>
                    <a
                      href={offer.qrData}
                      className="block break-all font-sans text-sm font-semibold text-primary hover:underline"
                    >
                      Open approval request
                    </a>
                    <Text size="sm" tone="muted" role="status" aria-live="polite">
                      Waiting for your signed approval…
                    </Text>
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => {
                        clearPending(genericPublicationError());
                        setOffer(undefined);
                      }}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              </div>
            ),
          }
        : {})}
    />
  );
}
