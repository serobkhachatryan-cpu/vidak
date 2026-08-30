/**
 * Presentation rules for a person's public name and a channel's public name/handle.
 * Technical identifiers (UUIDs, eNames, eVault IDs, local IDs) stay private.
 */

export const NEUTRAL_PUBLIC_DISPLAY_NAME = 'New Vidak member';
/** Legacy mock/product placeholder — not a chosen public name. */
export const STALE_CREATOR_PLACEHOLDER = 'Creator';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_ANYWHERE_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const UUID_PREFIX_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}(?:-[0-9a-f]{0,12})?/i;
const LOCAL_PLATFORM_ID_PATTERN =
  /^w3ds_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PublicDisplayNameIdentity {
  id?: string;
  eName?: string;
  eVaultId?: string;
}

function normalizedIdentityValues(identity?: PublicDisplayNameIdentity): string[] {
  const values: string[] = [];
  const push = (value: string | undefined) => {
    const trimmed = value?.trim();
    if (!trimmed) return;
    values.push(trimmed);
    const unat = trimmed.replace(/^@/, '');
    values.push(unat);
    values.push(unat.replace(/\.w3id$/i, ''));
    values.push(trimmed.replace(/^w3ds_/, ''));
  };
  push(identity?.id);
  push(identity?.eName);
  push(identity?.eVaultId);
  return values.filter(Boolean);
}

/** True when a string is a UUID, eName, local id, eVault id, or embeds one. */
export function looksLikeTechnicalIdentifier(value: string | null | undefined): boolean {
  const name = value?.trim() ?? '';
  if (!name) return true;
  if (name.startsWith('@')) return true;
  if (/\.w3id$/i.test(name)) return true;
  if (/w3ds_/i.test(name)) return true;
  if (UUID_PATTERN.test(name) || LOCAL_PLATFORM_ID_PATTERN.test(name)) return true;
  if (UUID_ANYWHERE_PATTERN.test(name) || UUID_PREFIX_PATTERN.test(name)) return true;
  return false;
}

export function isValidPublicDisplayName(
  value: string | null | undefined,
  identity?: PublicDisplayNameIdentity,
): value is string {
  const name = value?.trim() ?? '';
  if (!name) return false;
  if (name.toLocaleLowerCase() === STALE_CREATOR_PLACEHOLDER.toLocaleLowerCase()) return false;
  if (looksLikeTechnicalIdentifier(name)) return false;
  const identityValues = new Set(normalizedIdentityValues(identity).map((item) => item.trim()));
  if (identityValues.has(name)) return false;
  return true;
}

export function isPlatformPlaceholderDisplayName(value: string | null | undefined): boolean {
  const name = value?.trim() ?? '';
  if (!name) return true;
  if (name === NEUTRAL_PUBLIC_DISPLAY_NAME) return true;
  return name.toLocaleLowerCase() === STALE_CREATOR_PLACEHOLDER.toLocaleLowerCase();
}

/**
 * A chosen/verified public name the person actually intended, not a platform
 * placeholder and not a technical identifier.
 */
export function isChosenPublicDisplayName(
  value: string | null | undefined,
  identity?: PublicDisplayNameIdentity,
): value is string {
  return isValidPublicDisplayName(value, identity) && !isPlatformPlaceholderDisplayName(value);
}

/**
 * True when the stored public name is still the platform placeholder or an
 * identifier. A later verified-name grant may replace these; a chosen name
 * must not be overwritten without a separate explicit user action.
 */
export function isReplaceableWithVerifiedFullName(
  value: string | null | undefined,
  identity?: PublicDisplayNameIdentity,
): boolean {
  const name = value?.trim() ?? '';
  if (isPlatformPlaceholderDisplayName(name)) return true;
  return !isValidPublicDisplayName(name, identity);
}

/**
 * A later verified read may complete a first-name-only grant ("Serob" →
 * "Serob Kachatryan") without treating that as a manually chosen name.
 */
export function isVerifiedFullNameUpgrade(current: string, verified: string): boolean {
  const existing = current.trim();
  const next = verified.trim();
  if (!existing || !next || existing === next) return false;
  if (next.startsWith(`${existing} `) || next.startsWith(`${existing}-`)) return true;
  const firstToken = next.split(/\s+/)[0];
  return Boolean(firstToken) && firstToken === existing && next.length > existing.length;
}

export function isPublicHandle(
  value: string | null | undefined,
  identity?: PublicDisplayNameIdentity,
): value is string {
  const handle = value?.trim().replace(/^@/, '') ?? '';
  if (!handle) return false;
  if (handle.startsWith('w3ds_') || /w3ds_/i.test(handle)) return false;
  if (looksLikeTechnicalIdentifier(handle)) return false;
  if (LOCAL_PLATFORM_ID_PATTERN.test(`w3ds_${handle}`)) return false;
  if (identity?.id && handle === identity.id.trim()) return false;
  if (identity?.id && handle === identity.id.replace(/^w3ds_/, '')) return false;
  if (identity?.eVaultId && handle === identity.eVaultId.trim()) return false;
  if (identity?.eName) {
    const eName = identity.eName
      .trim()
      .replace(/^@/, '')
      .replace(/\.w3id$/i, '');
    if (handle === eName) return false;
  }
  return /^[a-z0-9][a-z0-9_-]{2,29}$/i.test(handle);
}
