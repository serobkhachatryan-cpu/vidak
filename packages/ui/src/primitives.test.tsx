import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  Avatar,
  Badge,
  Button,
  Checkbox,
  IconButton,
  Input,
  LoadingButton,
  Radio,
  Skeleton,
  Spinner,
  Tag,
} from './primitives';

describe('UI primitives', () => {
  it('renders button states with accessible loading semantics', () => {
    const markup = renderToStaticMarkup(
      <LoadingButton loading loadingText="Saving">
        Save
      </LoadingButton>,
    );
    expect(markup).toContain('disabled=""');
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain('Saving');
  });

  it('requires an accessible name for icon buttons', () => {
    const markup = renderToStaticMarkup(<IconButton aria-label="Close dialog">×</IconButton>);
    expect(markup).toContain('aria-label="Close dialog"');
    expect(markup).toContain('type="button"');
  });

  it('communicates invalid input state and token-based focus styling', () => {
    const markup = renderToStaticMarkup(<Input invalid aria-label="Video title" />);
    expect(markup).toContain('aria-invalid="true"');
    expect(markup).toContain('focus-visible:ring-primary');
  });

  it('associates checkbox and radio labels with their controls', () => {
    const checkbox = renderToStaticMarkup(<Checkbox id="publish" label="Publish video" />);
    const radio = renderToStaticMarkup(<Radio id="public" label="Public" name="visibility" />);
    expect(checkbox).toContain('for="publish"');
    expect(radio).toContain('type="radio"');
    expect(radio).toContain('for="public"');
  });

  it('renders feedback and display primitives with ARIA labels', () => {
    expect(renderToStaticMarkup(<Spinner aria-label="Loading library" />)).toContain(
      'role="status"',
    );
    expect(renderToStaticMarkup(<Skeleton />)).toContain('aria-busy="true"');
    expect(renderToStaticMarkup(<Avatar name="Ada Lovelace" />)).toContain('AL');
    expect(renderToStaticMarkup(<Badge tone="success">Live</Badge>)).toContain('bg-success');
  });

  it('makes removable tags and disabled buttons keyboard focusable only when enabled', () => {
    const tag = renderToStaticMarkup(<Tag onRemove={() => undefined}>Tutorial</Tag>);
    const button = renderToStaticMarkup(<Button disabled>Publish</Button>);
    expect(tag).toContain('aria-label="Remove tag"');
    expect(button).toContain('disabled=""');
  });
});
