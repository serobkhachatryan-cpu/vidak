# syntax=docker/dockerfile:1.7
FROM node:22.16.0-alpine AS base
RUN corepack enable
WORKDIR /app

FROM base AS dependencies
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps ./apps
COPY packages ./packages
RUN pnpm install --frozen-lockfile

FROM dependencies AS builder
ARG APP=web
COPY turbo.json tsconfig.base.json ./
RUN pnpm --filter "@w3ds/${APP}" build

FROM node:22.16.0-alpine AS runner
ENV NODE_ENV=production
WORKDIR /app
ARG APP=web
ENV APP=${APP}
COPY --from=builder /app/apps/${APP}/.next/standalone ./
COPY --from=builder /app/apps/${APP}/.next/static ./apps/${APP}/.next/static
COPY --from=builder /app/apps/${APP}/public ./apps/${APP}/public
EXPOSE 3000
ENV PORT=3000 HOSTNAME=0.0.0.0
CMD ["sh", "-c", "node apps/${APP}/server.js"]
