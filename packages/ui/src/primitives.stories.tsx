import type { Meta, StoryObj } from '@storybook/react-vite';
import {
  Avatar,
  Badge,
  Button,
  Card,
  Checkbox,
  Divider,
  Heading,
  IconButton,
  Input,
  Label,
  LoadingButton,
  Progress,
  Radio,
  SearchInput,
  Select,
  Skeleton,
  Spinner,
  Switch,
  Tag,
  Text,
  Textarea,
} from './primitives';

const meta = {
  title: 'Primitives/All',
  parameters: { layout: 'centered' },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const TextStory: Story = {
  name: 'Text',
  render: () => <Text tone="muted">Supporting copy for a video.</Text>,
};
export const HeadingStory: Story = {
  name: 'Heading',
  render: () => <Heading size="lg">Video details</Heading>,
};
export const LabelStory: Story = {
  name: 'Label',
  render: () => <Label htmlFor="demo-input">Video title</Label>,
};
export const ButtonStory: Story = { name: 'Button', render: () => <Button>Upload video</Button> };
export const IconButtonStory: Story = {
  name: 'IconButton',
  render: () => <IconButton aria-label="Close">×</IconButton>,
};
export const LoadingButtonStory: Story = {
  name: 'LoadingButton',
  render: () => (
    <LoadingButton loading loadingText="Saving">
      Save
    </LoadingButton>
  ),
};
export const InputStory: Story = {
  name: 'Input',
  render: () => <Input id="demo-input" placeholder="Video title" />,
};
export const SearchInputStory: Story = {
  name: 'SearchInput',
  render: () => <SearchInput placeholder="Search videos" onClear={() => undefined} />,
};
export const TextareaStory: Story = {
  name: 'Textarea',
  render: () => <Textarea placeholder="Describe this video" />,
};
export const CheckboxStory: Story = {
  name: 'Checkbox',
  render: () => <Checkbox label="Publish immediately" />,
};
export const SwitchStory: Story = {
  name: 'Switch',
  render: () => <Switch label="Enable comments" />,
};
export const RadioStory: Story = {
  name: 'Radio',
  render: () => <Radio name="visibility" label="Public" />,
};
export const ProgressStory: Story = {
  name: 'Progress',
  render: () => (
    <div className="w-72 space-y-2">
      <Text size="sm" tone="muted">
        Uploading…
      </Text>
      <Progress value={62} label="Upload progress" />
    </div>
  ),
};
export const SelectStory: Story = {
  name: 'Select',
  render: () => (
    <div className="w-72 space-y-2">
      <Label htmlFor="demo-category">Category</Label>
      <Select id="demo-category" defaultValue="education">
        <option value="education">Education</option>
        <option value="entertainment">Entertainment</option>
      </Select>
    </div>
  ),
};
export const CardStory: Story = {
  name: 'Card',
  render: () => (
    <Card elevated className="w-72">
      <Heading size="sm">New upload</Heading>
      <Text size="sm" tone="muted">
        Ready to share.
      </Text>
    </Card>
  ),
};
export const AvatarStory: Story = { name: 'Avatar', render: () => <Avatar name="W3DS Video" /> };
export const BadgeStory: Story = {
  name: 'Badge',
  render: () => <Badge tone="success">Published</Badge>,
};
export const TagStory: Story = {
  name: 'Tag',
  render: () => <Tag onRemove={() => undefined}>Tutorial</Tag>,
};
export const DividerStory: Story = {
  name: 'Divider',
  render: () => (
    <div className="w-72">
      <Text>Above</Text>
      <Divider className="my-3" />
      <Text>Below</Text>
    </div>
  ),
};
export const SpinnerStory: Story = {
  name: 'Spinner',
  render: () => <Spinner aria-label="Loading uploads" />,
};
export const SkeletonStory: Story = {
  name: 'Skeleton',
  render: () => <Skeleton className="h-24 w-72" />,
};
