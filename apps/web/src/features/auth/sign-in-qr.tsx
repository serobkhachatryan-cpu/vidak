'use client';

import QRCode from 'qrcode';
import { useEffect, useState } from 'react';

/**
 * Renders a product sign-in QR code for an opaque deep-link URI.
 * Uses a small local generator — no external QR service calls.
 */
export function SignInQr({ value, size = 192 }: { value: string; size?: number }) {
  const [dataUrl, setDataUrl] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    void QRCode.toDataURL(value, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: size,
      color: { dark: '#111111', light: '#ffffff' },
    }).then((url) => {
      if (!cancelled) setDataUrl(url);
    });
    return () => {
      cancelled = true;
    };
  }, [size, value]);

  if (!dataUrl) {
    return (
      <div
        className="rounded-md border border-border bg-surface"
        style={{ width: size, height: size }}
        aria-hidden="true"
      />
    );
  }

  return (
    <img
      src={dataUrl}
      width={size}
      height={size}
      alt="Sign-in QR code"
      className="rounded-md border border-border bg-white"
    />
  );
}
