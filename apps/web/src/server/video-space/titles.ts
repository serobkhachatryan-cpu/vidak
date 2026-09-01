import type { VideoSpaceKind } from './adapters';

export interface ResolveVideoSpaceTitleInput {
  title?: string | undefined;
  caption?: string | undefined;
  filename?: string | undefined;
  messageText?: string | undefined;
  conversationTitle?: string | undefined;
  createdAt?: string | undefined;
  kind?: VideoSpaceKind;
}

/** Human-readable title from a filename, without extension. */
export function titleFromFilename(filename: string): string | undefined {
  const base = filename
    .replace(/\.[^.]+$/, '')
    .replace(/[_-]+/g, ' ')
    .trim();
  if (!base) return undefined;
  return base.replace(/\b\w/g, (char) => char.toLocaleUpperCase());
}

function firstNonEmpty(values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function trimMessageText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const singleLine = trimmed.replace(/\s+/g, ' ');
  if (singleLine.length <= 120) return singleLine;
  return `${singleLine.slice(0, 117).trimEnd()}…`;
}

function formatTitleDate(createdAt: string): string {
  const parsed = new Date(createdAt);
  if (Number.isNaN(parsed.getTime())) return createdAt.slice(0, 10);
  return parsed.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/**
 * Viewer-facing title priority:
 * title/caption → filename without extension → message text →
 * call/conversation title plus date → "Untitled video".
 */
export function resolveVideoSpaceTitle(input: ResolveVideoSpaceTitleInput): string {
  const explicit = firstNonEmpty([input.title, input.caption]);
  if (explicit) return explicit;

  const fromFilename = input.filename ? titleFromFilename(input.filename) : undefined;
  if (fromFilename) return fromFilename;

  const message = trimMessageText(input.messageText);
  if (message) return message;

  if (input.kind === 'call-recording') {
    if (input.conversationTitle && input.createdAt) {
      return `${input.conversationTitle} · ${formatTitleDate(input.createdAt)}`;
    }
    if (input.createdAt) return `Call recording · ${formatTitleDate(input.createdAt)}`;
    return 'Call recording';
  }

  if (input.conversationTitle && input.createdAt) {
    return `${input.conversationTitle} · ${formatTitleDate(input.createdAt)}`;
  }

  return 'Untitled video';
}
