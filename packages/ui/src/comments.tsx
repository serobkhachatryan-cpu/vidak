'use client';

import type {
  Comment,
  CommentId,
  CommentReaction,
  CommentRichText,
  CommentSort,
  UserProfile,
} from '@w3ds/types';
import { type FormEvent, type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';
import { EmptyState, ErrorState } from './layout';
import { Avatar, Button, Skeleton, Text } from './primitives';
import { cx } from './utils';

const compactNumber = new Intl.NumberFormat('en', {
  notation: 'compact',
  maximumFractionDigits: 1,
});

export type CommentAuthor = Pick<
  UserProfile,
  'displayName' | 'handle' | 'avatarUrl' | 'isVerified'
>;

function serializeRichText(root: HTMLElement): CommentRichText[] {
  const fragments: CommentRichText[] = [];
  const visit = (node: Node, styles: Omit<CommentRichText, 'text'>) => {
    if (node.nodeType === Node.TEXT_NODE && node.textContent) {
      fragments.push({ text: node.textContent, ...styles });
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    const tag = node.tagName.toLowerCase();
    const nextStyles = {
      ...styles,
      ...(tag === 'strong' || tag === 'b' ? { bold: true } : {}),
      ...(tag === 'em' || tag === 'i' ? { italic: true } : {}),
      ...(tag === 'a' && /^https?:\/\//.test((node as HTMLAnchorElement).href)
        ? { link: (node as HTMLAnchorElement).href }
        : {}),
    };
    if (tag === 'div' || tag === 'br') fragments.push({ text: '\n', ...nextStyles });
    node.childNodes.forEach((child) => {
      visit(child, nextStyles);
    });
  };
  root.childNodes.forEach((child) => {
    visit(child, {});
  });
  return fragments;
}

export interface CommentEditorProps {
  onSubmit: (body: string, richText: readonly CommentRichText[]) => void | Promise<void>;
  onCancel?: () => void;
  placeholder?: string;
  submitLabel?: string;
  autoFocus?: boolean;
  isSubmitting?: boolean;
  className?: string;
}

export function CommentEditor({
  onSubmit,
  onCancel,
  placeholder = 'Add a comment…',
  submitLabel = 'Comment',
  autoFocus = false,
  isSubmitting = false,
  className,
}: CommentEditorProps) {
  const editorRef = useRef<HTMLDivElement>(null);
  const [value, setValue] = useState('');
  const [isFocused, setIsFocused] = useState(autoFocus);
  const labelId = useId();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const body = value.trim();
    if (!body) return;
    await onSubmit(
      body,
      editorRef.current ? serializeRichText(editorRef.current) : [{ text: body }],
    );
    setValue('');
    if (editorRef.current) editorRef.current.textContent = '';
  };
  const format = (command: 'bold' | 'italic') => {
    editorRef.current?.focus();
    document.execCommand(command);
  };

  return (
    <form onSubmit={submit} className={cx('space-y-2', className)}>
      <span id={labelId} className="sr-only">
        {placeholder}
      </span>
      <div className="rounded-lg border border-border bg-surface p-2 focus-within:ring-2 focus-within:ring-primary focus-within:ring-offset-2 focus-within:ring-offset-background">
        <div className="flex gap-1 border-b border-border pb-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label="Bold selected text"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => format('bold')}
          >
            <strong aria-hidden="true">B</strong>
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label="Italicize selected text"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => format('italic')}
          >
            <em aria-hidden="true">I</em>
          </Button>
        </div>
        {/* biome-ignore lint/a11y/useSemanticElements: contentEditable rich-text formatting (bold/italic) requires a div; role="textbox" follows the WAI-ARIA editable-content pattern and is asserted by tests. */}
        <div
          ref={editorRef}
          role="textbox"
          tabIndex={0}
          aria-labelledby={labelId}
          aria-multiline="true"
          contentEditable={!isSubmitting}
          suppressContentEditableWarning
          data-placeholder={placeholder}
          onFocus={() => setIsFocused(true)}
          onInput={(event) => setValue(event.currentTarget.textContent ?? '')}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
              void submit(event as unknown as FormEvent);
            }
          }}
          className="min-h-20 px-2 py-3 font-sans text-sm text-foreground outline-none empty:before:pointer-events-none empty:before:text-muted-foreground empty:before:content-[attr(data-placeholder)]"
        />
      </div>
      {isFocused && (
        <div className="flex flex-wrap justify-end gap-2">
          {onCancel && (
            <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
              Cancel
            </Button>
          )}
          <Button type="submit" size="sm" disabled={!value.trim()} isLoading={isSubmitting}>
            {submitLabel}
          </Button>
        </div>
      )}
    </form>
  );
}

function RichCommentText({ comment }: { comment: Comment }) {
  const fragments = comment.richText?.length ? comment.richText : [{ text: comment.body }];
  const seenKeys = new Map<string, number>();
  const keyFor = (fragment: CommentRichText) => {
    const base = `${fragment.text}|${fragment.bold ?? ''}|${fragment.italic ?? ''}|${fragment.link ?? ''}`;
    const occurrence = seenKeys.get(base) ?? 0;
    seenKeys.set(base, occurrence + 1);
    return `${base}#${occurrence}`;
  };
  return (
    <Text as="div" size="sm" className="whitespace-pre-wrap break-words">
      {fragments.map((fragment) => {
        const key = keyFor(fragment);
        const content = fragment.italic ? <em key={key}>{fragment.text}</em> : fragment.text;
        const styled = fragment.bold ? <strong key={key}>{content}</strong> : content;
        const isSafeLink = fragment.link && /^https?:\/\//.test(fragment.link);
        return isSafeLink ? (
          <a
            key={key}
            href={fragment.link}
            className="text-primary underline underline-offset-2"
            target="_blank"
            rel="noreferrer"
          >
            {styled}
          </a>
        ) : (
          <span key={key}>{styled}</span>
        );
      })}
    </Text>
  );
}

export interface CommentItemProps {
  comment: Comment;
  author?: CommentAuthor | undefined;
  replies?: readonly Comment[] | undefined;
  repliesByParent?: Readonly<Record<CommentId, readonly Comment[] | undefined>> | undefined;
  authors?: Readonly<Record<string, CommentAuthor | undefined>> | undefined;
  depth?: number;
  onReply?:
    | ((
        comment: Comment,
        body: string,
        richText: readonly CommentRichText[],
      ) => void | Promise<void>)
    | undefined;
  onReaction?: ((comment: Comment, reaction: CommentReaction | undefined) => void) | undefined;
  onLoadReplies?: ((comment: Comment) => void) | undefined;
}

export function CommentItem({
  comment,
  author,
  replies = [],
  repliesByParent,
  authors,
  depth = 0,
  onReply,
  onReaction,
  onLoadReplies,
}: CommentItemProps) {
  const [replying, setReplying] = useState(false);
  const [showReplies, setShowReplies] = useState(false);
  const [reaction, setReaction] = useState<CommentReaction | undefined>(comment.viewerReaction);
  const replyLabel = `${comment.replyCount} ${comment.replyCount === 1 ? 'reply' : 'replies'}`;
  const authorName = author?.displayName ?? 'Unknown creator';
  const changeReaction = (nextReaction: CommentReaction) => {
    const next = reaction === nextReaction ? undefined : nextReaction;
    setReaction(next);
    onReaction?.(comment, next);
  };

  return (
    <article
      // biome-ignore lint/a11y/noNoninteractiveTabindex: comments use a roving-tabindex pattern (Comments UI hint: "Use arrow keys to move between comments").
      tabIndex={0}
      aria-label={`Comment from ${authorName}`}
      className={cx(
        'rounded-lg p-2 outline-none transition-colors focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-primary',
        depth > 0 && 'border-l-2 border-border pl-4',
      )}
    >
      <div className="flex gap-3">
        <Avatar src={author?.avatarUrl} name={authorName} alt="" size="sm" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2">
            <span className="font-sans text-sm font-semibold text-foreground">{authorName}</span>
            {author?.isVerified && (
              <span role="img" aria-label="Verified creator" className="text-primary">
                ✓
              </span>
            )}
            {author?.handle && (
              <Text as="span" size="xs" tone="muted">
                @{author.handle}
              </Text>
            )}
          </div>
          <RichCommentText comment={comment} />
          <div className="mt-2 flex flex-wrap items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              aria-label={`Like comment (${compactNumber.format(comment.likeCount)})`}
              aria-pressed={reaction === 'like'}
              onClick={() => changeReaction('like')}
            >
              <span aria-hidden="true">👍</span>{' '}
              {compactNumber.format(comment.likeCount + (reaction === 'like' ? 1 : 0))}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              aria-label="Dislike comment"
              aria-pressed={reaction === 'dislike'}
              onClick={() => changeReaction('dislike')}
            >
              <span aria-hidden="true">👎</span>
            </Button>
            {onReply && (
              <Button variant="ghost" size="sm" onClick={() => setReplying((open) => !open)}>
                Reply
              </Button>
            )}
          </div>
        </div>
      </div>
      {replying && onReply && (
        <CommentEditor
          className="ml-11 mt-3"
          placeholder={`Reply to ${authorName}…`}
          submitLabel="Reply"
          autoFocus
          onCancel={() => setReplying(false)}
          onSubmit={async (body, richText) => {
            await onReply(comment, body, richText);
            setReplying(false);
          }}
        />
      )}
      {comment.replyCount > 0 && (
        <div className="ml-11 mt-2">
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={showReplies}
            onClick={() => {
              if (!showReplies) onLoadReplies?.(comment);
              setShowReplies((open) => !open);
            }}
          >
            {showReplies ? 'Hide' : 'Show'} {replyLabel}
          </Button>
          {showReplies && replies.length > 0 && (
            <div className="mt-2 space-y-3">
              {replies.map((reply) => (
                <CommentItem
                  key={reply.id}
                  comment={reply}
                  author={authors?.[reply.authorId]}
                  replies={repliesByParent?.[reply.id]}
                  repliesByParent={repliesByParent}
                  authors={authors}
                  depth={depth + 1}
                  onReply={onReply}
                  onReaction={onReaction}
                  onLoadReplies={onLoadReplies}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </article>
  );
}

export function CommentListSkeleton({ count = 3 }: { count?: number }) {
  return (
    <div role="status" aria-label="Loading comments" className="space-y-5">
      {Array.from({ length: count }, () => crypto.randomUUID()).map((key) => (
        <div key={key} className="flex gap-3">
          <Skeleton circle className="h-8 w-8" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-3 w-32" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-3/5" />
          </div>
        </div>
      ))}
    </div>
  );
}

export interface CommentListProps {
  comments: readonly Comment[];
  authors?: Readonly<Record<string, CommentAuthor | undefined>> | undefined;
  repliesByParent?: Readonly<Record<CommentId, readonly Comment[] | undefined>> | undefined;
  hasNextPage?: boolean | undefined;
  isFetchingNextPage?: boolean | undefined;
  onLoadMore?: (() => void) | undefined;
  onReply?: CommentItemProps['onReply'];
  onReaction?: CommentItemProps['onReaction'];
  onLoadReplies?: CommentItemProps['onLoadReplies'];
}

export function CommentList({
  comments,
  authors,
  repliesByParent,
  hasNextPage = false,
  isFetchingNextPage = false,
  onLoadMore,
  onReply,
  onReaction,
  onLoadReplies,
}: CommentListProps) {
  const sentinelRef = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (!hasNextPage || isFetchingNextPage || !onLoadMore || !sentinelRef.current) return;
    if (!('IntersectionObserver' in window)) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) onLoadMore();
    });
    observer.observe(sentinelRef.current);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, onLoadMore]);
  const onListKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>('article[tabindex="0"]'),
    );
    const current = items.indexOf(document.activeElement as HTMLElement);
    if (current < 0) return;
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? items.length - 1
          : current + (event.key === 'ArrowDown' ? 1 : -1);
    const target = items[Math.max(0, Math.min(next, items.length - 1))];
    if (target) {
      event.preventDefault();
      target.focus();
    }
  };

  return (
    <ul aria-label="Comment list" onKeyDown={onListKeyDown} className="space-y-3">
      {comments.map((comment) => (
        <li key={comment.id}>
          <CommentItem
            comment={comment}
            author={authors?.[comment.authorId]}
            replies={repliesByParent?.[comment.id]}
            repliesByParent={repliesByParent}
            authors={authors}
            onReply={onReply}
            onReaction={onReaction}
            onLoadReplies={onLoadReplies}
          />
        </li>
      ))}
      {(hasNextPage || isFetchingNextPage) && (
        <li ref={sentinelRef} className="flex justify-center py-2">
          <Button variant="secondary" size="sm" onClick={onLoadMore} isLoading={isFetchingNextPage}>
            Load more comments
          </Button>
        </li>
      )}
    </ul>
  );
}

export type CommentsState = 'ready' | 'loading' | 'empty' | 'error';

export interface CommentsProps extends CommentListProps {
  state?: CommentsState;
  totalCount?: number;
  sort?: CommentSort;
  onSortChange?: ((sort: CommentSort) => void) | undefined;
  onSubmit?: CommentEditorProps['onSubmit'] | undefined;
  onRetry?: (() => void) | undefined;
  className?: string;
}

export function Comments({
  state = 'ready',
  totalCount,
  sort = 'top',
  onSortChange,
  onSubmit,
  onRetry,
  className,
  ...listProps
}: CommentsProps) {
  return (
    <section aria-labelledby="comments-heading" className={cx('space-y-5', className)}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2
            id="comments-heading"
            className="font-sans text-xl font-bold tracking-tight text-foreground"
          >
            Comments{totalCount === undefined ? '' : ` (${compactNumber.format(totalCount)})`}
          </h2>
          <Text size="xs" tone="muted" className="mt-1">
            Use arrow keys to move between comments.
          </Text>
        </div>
        <label className="flex items-center gap-2 font-sans text-sm text-foreground">
          Sort by
          <select
            value={sort}
            onChange={(event) => onSortChange?.(event.target.value as CommentSort)}
            className="h-9 rounded-md border border-border bg-surface px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <option value="top">Top</option>
            <option value="newest">Newest</option>
          </select>
        </label>
      </div>
      {onSubmit && <CommentEditor onSubmit={onSubmit} />}
      {state === 'loading' ? (
        <CommentListSkeleton />
      ) : state === 'error' ? (
        <ErrorState
          title="Could not load comments"
          description="Please try again."
          retry={onRetry}
        />
      ) : state === 'empty' ? (
        <EmptyState icon="◌" title="No comments yet" description="Start the conversation." />
      ) : (
        <CommentList {...listProps} />
      )}
    </section>
  );
}
