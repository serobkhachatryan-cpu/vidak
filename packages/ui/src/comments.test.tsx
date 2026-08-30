import type { Comment } from '@w3ds/types';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CommentEditor, CommentItem, Comments } from './comments';

const comment: Comment = {
  id: 'comment-1',
  videoId: 'video-design-system',
  authorId: 'user-grace',
  body: 'A thoughtful comment.',
  richText: [{ text: 'A thoughtful ', bold: true }, { text: 'comment.' }],
  createdAt: '2026-07-14T13:00:00.000Z',
  likeCount: 42,
  replyCount: 1,
};

const author = {
  displayName: 'Grace Hopper',
  handle: 'grace-hopper',
  isVerified: true,
};

describe('Comments', () => {
  it('renders rich content, nested replies, and accessible comment actions', () => {
    const markup = renderToStaticMarkup(
      <Comments
        comments={[comment]}
        totalCount={1}
        authors={{ [comment.authorId]: author }}
        repliesByParent={{
          [comment.id]: [{ ...comment, id: 'reply-1', parentId: comment.id, replyCount: 0 }],
        }}
        onReply={() => undefined}
      />,
    );

    expect(markup).toContain('aria-label="Comment list"');
    expect(markup).toContain('aria-label="Like comment (42)"');
    expect(markup).toContain('aria-label="Dislike comment"');
    expect(markup).toContain('Verified creator');
    expect(markup).toContain('Show 1 reply');
    expect(markup).toContain('<strong>A thoughtful </strong>');
  });

  it('renders loading, empty, and error states', () => {
    expect(renderToStaticMarkup(<Comments state="loading" comments={[]} />)).toContain(
      'aria-label="Loading comments"',
    );
    expect(renderToStaticMarkup(<Comments state="empty" comments={[]} />)).toContain(
      'No comments yet',
    );
    expect(renderToStaticMarkup(<Comments state="error" comments={[]} />)).toContain(
      'Could not load comments',
    );
    expect(
      renderToStaticMarkup(
        <Comments state="unavailable" comments={[]} onSubmit={() => undefined} />,
      ),
    ).toContain('Comments are not available yet');
    expect(
      renderToStaticMarkup(
        <Comments state="unavailable" comments={[]} onSubmit={() => undefined} />,
      ),
    ).not.toContain('role="textbox"');
  });

  it('renders a keyboard-accessible rich text editor', () => {
    const markup = renderToStaticMarkup(<CommentEditor onSubmit={() => undefined} />);

    expect(markup).toContain('role="textbox"');
    expect(markup).toContain('aria-multiline="true"');
    expect(markup).toContain('aria-label="Bold selected text"');
    expect(markup).toContain('aria-label="Italicize selected text"');
  });

  it('shows reply controls without making the avatar contentful', () => {
    const markup = renderToStaticMarkup(
      <CommentItem comment={comment} author={author} onReply={() => undefined} />,
    );

    expect(markup).toContain('Reply');
    expect(markup).toContain('aria-label="Grace Hopper"');
  });
});
