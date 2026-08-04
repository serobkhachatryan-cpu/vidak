import type { Meta, StoryObj } from '@storybook/react-vite';
import type { Comment } from '@w3ds/types';
import { Comments } from './comments';

const comments: readonly Comment[] = [
  {
    id: 'comment-foundation',
    videoId: 'video-design-system',
    authorId: 'user-grace',
    body: 'A small, well-owned foundation makes a design system much easier to evolve.',
    richText: [
      { text: 'A small, well-owned foundation', bold: true },
      { text: ' makes a design system much easier to evolve.' },
    ],
    createdAt: '2026-07-14T13:00:00.000Z',
    likeCount: 42,
    replyCount: 1,
  },
  {
    id: 'comment-documentation',
    videoId: 'video-design-system',
    authorId: 'user-ada',
    body: 'Would love a follow-up on documenting component decisions.',
    createdAt: '2026-07-15T10:00:00.000Z',
    likeCount: 8,
    replyCount: 0,
  },
];

const meta = {
  title: 'Video domain/Comments',
  component: Comments,
  args: {
    comments,
    totalCount: 2,
    authors: {
      'user-grace': {
        displayName: 'Grace Hopper',
        handle: 'grace-hopper',
        avatarUrl:
          'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=160&h=160&fit=crop',
        isVerified: false,
      },
      'user-ada': {
        displayName: 'Ada Lovelace',
        handle: 'ada-lovelace',
        avatarUrl:
          'https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=160&h=160&fit=crop',
        isVerified: true,
      },
    },
    repliesByParent: {
      'comment-foundation': [
        {
          id: 'reply-thanks',
          videoId: 'video-design-system',
          parentId: 'comment-foundation',
          authorId: 'user-ada',
          body: 'Thank you — ownership keeps the system sustainable.',
          createdAt: '2026-07-14T14:00:00.000Z',
          likeCount: 12,
          replyCount: 0,
        },
      ],
    },
  },
} satisfies Meta<typeof Comments>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Loading: Story = { args: { state: 'loading' } };
export const Empty: Story = { args: { state: 'empty', comments: [] } };
export const ErrorState: Story = { args: { state: 'error' } };
export const Dark: Story = {
  decorators: [
    (Story) => (
      <div className="dark bg-background p-6">
        <Story />
      </div>
    ),
  ],
};
