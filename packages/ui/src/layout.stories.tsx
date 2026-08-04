import type { Meta, StoryObj } from '@storybook/react-vite';
import {
  AppShell,
  Breadcrumbs,
  Button,
  Card,
  Container,
  EmptyState,
  ErrorState,
  Grid,
  Header,
  LoadingState,
  Page,
  Section,
  Sidebar,
  SplitPane,
  Stack,
  Text,
} from './index.js';

const meta = {
  title: 'Layout/Application shell',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

const navigation = [
  { label: 'Overview', href: '#overview', current: true },
  { label: 'Videos', href: '#videos' },
  { label: 'Analytics', href: '#analytics' },
];

export const Shell: Story = {
  render: () => (
    <AppShell
      header={<Header brand={<strong>W3DS</strong>} actions={<Button size="sm">Upload</Button>} />}
      sidebar={<Sidebar items={navigation} footer={<Text size="sm" tone="muted">Workspace settings</Text>} />}
      mobileNavigation={<Sidebar items={navigation} />}
    >
      <Page
        title="Video library"
        description="Manage every video in your workspace."
        breadcrumbs={<Breadcrumbs items={[{ label: 'Workspace', href: '#' }, { label: 'Videos' }]} />}
        actions={<Button>Upload video</Button>}
      >
        <Grid columns={3}>
          {['Published', 'Drafts', 'Views'].map((label) => <Card key={label}>{label}</Card>)}
        </Grid>
      </Page>
    </AppShell>
  ),
};

export const LayoutPrimitives: Story = {
  render: () => (
    <Container>
      <Stack gap={8}>
        <Section title="Section heading" description="Helpful supporting content." action={<Button size="sm">Action</Button>}>
          <Grid columns={3}>{['One', 'Two', 'Three'].map((item) => <Card key={item}>{item}</Card>)}</Grid>
        </Section>
        <SplitPane aside={<Card>Filters</Card>}><Card>Content area</Card></SplitPane>
      </Stack>
    </Container>
  ),
};

export const States: Story = {
  render: () => (
    <Container size="md">
      <Stack gap={4}>
        <EmptyState icon="◌" title="No videos yet" description="Upload your first video to get started." action={<Button>Upload video</Button>} />
        <ErrorState title="Could not load videos" description="Please check your connection and try again." retry={() => undefined} />
        <LoadingState />
      </Stack>
    </Container>
  ),
};
