# Milestone 7A — Repository Integration Review

Reviewed on 2026-08-04 after the Watch Page milestone.

## Result

The workspace has a clean, acyclic dependency flow and one responsibility per
package. The review found one meaningful duplication: the Web application's
header, navigation, mobile drawer, and dark-mode control were implemented in
both the Home Feed and Watch Page. They now use the shared
`apps/web/src/components/application-shell.tsx` component.

No public package API was changed.

## Integration findings

### Packages and dependency graph

- Workspace package names are unique; there are no duplicate package
  boundaries.
- The application dependency graph is one-way:

  ```text
  apps/web → watch-page → hooks → api-client → types
  apps/web → ui → design-tokens
  ```

- `@w3ds/watch-page` consumes existing UI, hooks, API-client types, and domain
  types rather than duplicating them.
- `apps/web` declares every workspace package it imports directly, including
  `@w3ds/types` and `@w3ds/watch-page`.
- `ApplicationShell` uses `@w3ds/config` for the product name, so the shared
  configuration package is no longer an unused direct dependency in the Web
  application.

### Components, hooks, utilities, and types

- Shared page chrome is centralised in `ApplicationShell`.
- `@w3ds/ui` remains the single owner of reusable primitives, layout
  components, and feed cards.
- `@w3ds/hooks` remains the single owner of video query hooks.
- Video, channel, pagination, and related domain types are defined once in
  `@w3ds/types`.
- The small `cx` and focus-ring helpers remain package-local implementation
  details. Consolidating them would require expanding a public package API and
  would not reduce consumer complexity.
- `WatchPageData` limits related videos to the current channel, so the existing
  channel query supplies complete channel metadata without per-card queries.

### Public exports

- Packages with implementation expose their public API through `src/index.ts`.
- `@w3ds/watch-page` exports the presentational page, data-backed page, and
  associated prop types from its barrel.
- Internal source imports use extensionless paths so Next.js, Vitest, and
  Storybook resolve workspace source consistently.

### Accessibility and responsive behavior

- Watch Page uses labelled player, action, description, tags, and related-video
  regions.
- The action set uses a native `fieldset` and the tags use a semantic list.
- Layout adapts from a single column to a desktop main/aside split; related
  videos use a tablet grid and desktop sidebar.
- Tests cover page content, loading/empty/error states, dark mode, action
  semantics, tags, and responsive layout classes.

## Validation

The following commands passed:

```text
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm storybook:build
```

Storybook built the Watch Page stories successfully. The build emits its
existing large-chunk advisory only; it does not affect the build result.

## Follow-up opportunities

- Add browser-level tests for dark mode, mobile navigation, and Watch Page data
  loading once e2e coverage expands beyond the current smoke tests.
- Add viewport and interaction coverage to Storybook when its testing addons
  are introduced. Current responsive assertions verify the intended breakpoint
  classes but do not exercise browser reflow.
- Add a generated-token consistency check to prevent `styles.css` drifting from
  `createCssVariables`.
