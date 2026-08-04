import { formatWebsiteLabel } from './format';
import { cx, focusRing } from './styles';

/** External profile website link with a consistent focus ring and new-tab announcement. */
export function ProfileWebsiteLink({
  url,
  className,
}: {
  url: string;
  className?: string | undefined;
}) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className={cx('text-primary hover:underline', focusRing, className)}
    >
      {formatWebsiteLabel(url)}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}
