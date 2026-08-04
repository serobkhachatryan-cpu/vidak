# W3DS Video

Production-grade decentralized video hosting platform.

## Repository layout

- `apps/web` — creator and viewer application
- `apps/admin` — operational administration console
- `apps/landing` — public marketing site
- `apps/docs` — product and developer documentation
- `packages/*` — shared platform libraries

## Requirements

- Node.js 22.16 or newer
- pnpm 11.20 or newer
- Docker (optional, for container builds)

## Commands

```bash
pnpm install
pnpm dev
pnpm lint
pnpm typecheck
pnpm test:unit
pnpm build
pnpm storybook:build
```

Run browser tests after installing Playwright's Chromium runtime:

```bash
pnpm exec playwright install chromium
pnpm test:e2e
```

Build a production web image:

```bash
docker build --build-arg APP=web -t w3ds-video-web .
```

## Workspace conventions

All internal packages use the `@w3ds/*` scope and workspace protocol. Build, test, lint, and typecheck tasks are orchestrated with Turborepo. Biome is the single formatter and linter.
