# Foundation Quality Review

Reviewed on 2026-08-04 across the repository architecture, package graph, token
system, UI library, application shell, documentation, domain types, mock API,
React usage, accessibility, Storybook, and test suite.

## Result

No Critical implementation defects were identified. The foundation has a clear
one-way dependency flow:

```text
apps/web → hooks → api-client → types
apps/web → ui → design-tokens
```

There are no `any` usages, unsafe double casts, TypeScript suppression
directives, or circular workspace dependencies in the reviewed source. Shared
packages expose their public types through package barrels, and the current UI
surface uses semantic token utilities, native controls, visible keyboard focus,
and labelled landmarks.

## Critical

None. No code changes were necessary for this priority.

## Important

1. **Documentation no longer describes the implemented product surface.**
   `docs/architecture.md`, `docs/frontend.md`, `docs/backend.md`,
   `docs/design-system.md`, `docs/decisions.md`, and `docs/roadmap.md` still
   say the web app is a bootstrap screen and that `@w3ds/types`,
   `@w3ds/api-client`, and `@w3ds/hooks` are empty. They should be updated with
   the domain foundation, typed mock client, React Query hooks, token adoption,
   and Home feed before those documents are treated as architectural reference.

2. **Home-feed behavior has no browser-level coverage.**
   `e2e/home.spec.ts` only asserts the page title. Add Playwright coverage for
   public-video rendering, the dark-mode switch, opening/closing the mobile
   drawer with Escape, keyboard-visible focus, and the infinite-scroll
   sentinel. This will exercise the client-only behavior that static markup
   tests cannot.

3. **Storybook has no interaction tests.**
   Existing stories document component states, but none verify keyboard or
   pointer behavior. Add `play` functions for the mobile drawer focus trap,
   removable tags, switches, and the VideoCard links when Storybook test
   tooling is introduced.

4. **The Home feed resolves channels per card.**
   `FeedVideoCard` calls `useChannel` once for every video. React Query
   deduplicates equal channel IDs, so the current mock data results in a single
   request, but a feed with many channels produces an N+1 request pattern.
   Add a batched channel endpoint or return channel summaries with feed items
   when a real API contract is defined.

5. **`styles.css` can drift from its TypeScript token source.**
   The stylesheet is described as generated, but no generation command or test
   verifies it matches `createCssVariables`. Add a small generation script or
   snapshot/consistency test before the token set expands.

## Nice to have

1. Add package-specific test commands to currently placeholder packages so
   Turbo's intended quality surface is explicit as the packages gain code.
2. Use branded IDs only if identifiers from multiple domains routinely cross
   API boundaries; plain strings are currently appropriate and avoid premature
   complexity.
3. Replace text-symbol navigation icons with the shared icons package once it
   exports accessible icon components.
4. Add visual-regression coverage for light and dark themes after the feed UI
   stabilizes.

## Validation

The requested commands could not run in this workspace because the execution
environment has neither `node` nor `pnpm` installed:

```text
pnpm lint       # unavailable: pnpm command not found
pnpm typecheck  # unavailable: pnpm command not found
pnpm test       # unavailable: pnpm command not found
pnpm build      # unavailable: pnpm command not found
```

Run the commands above in a Node.js 22.16+ and pnpm 11.20+ environment before
merging future changes.
