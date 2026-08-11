import { type SVGProps, useId } from 'react';

export interface VidakLogoProps extends Omit<SVGProps<SVGSVGElement>, 'children'> {
  title?: string;
}

/** The Vidak product mark and wordmark, rendered as an accessible inline SVG. */
export function VidakLogo({ title = 'Vidak', ...props }: VidakLogoProps) {
  const titleId = useId();

  return (
    <svg
      role="img"
      aria-labelledby={titleId}
      viewBox="0 0 164 48"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <title id={titleId}>{title}</title>
      <rect width="48" height="48" rx="13" fill="#102A4C" />
      <path d="M11 13h7.2L24 31.9 29.8 13H37L24 37 11 13Z" fill="white" />
      <circle cx="36.5" cy="11.5" r="4.5" fill="#22C6C8" />
      <text
        x="60"
        y="33.5"
        fill="currentColor"
        fontFamily="var(--w3ds-font-family-sans), sans-serif"
        fontSize="28"
        fontWeight="700"
        letterSpacing="-1.2"
      >
        Vidak
      </text>
    </svg>
  );
}
