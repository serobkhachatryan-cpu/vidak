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
# The standalone server traces database query modules, but not Drizzle's migration
# reader because it only runs in Railway's pre-deploy phase. Add those two small
# runtime modules and workspace links to the standalone artifact so migrations run
# with the same locked pg and drizzle-orm versions as the application.
RUN if [ "${APP}" = "web" ]; then \
      set -eux; \
      standalone="apps/${APP}/.next/standalone"; \
      drizzle_source="$(find node_modules/.pnpm -maxdepth 1 -type d -name 'drizzle-orm@*' -print -quit)"; \
      drizzle_target="$(find "${standalone}/node_modules/.pnpm" -maxdepth 1 -type d -name 'drizzle-orm@*' -print -quit)"; \
      pg_target="$(find "${standalone}/node_modules/.pnpm" -maxdepth 1 -type d -name 'pg@*' -print -quit)"; \
      test -n "${drizzle_source}"; \
      test -n "${drizzle_target}"; \
      test -n "${pg_target}"; \
      cp "${drizzle_source}/node_modules/drizzle-orm/migrator.js" "${drizzle_target}/node_modules/drizzle-orm/migrator.js"; \
      cp "${drizzle_source}/node_modules/drizzle-orm/node-postgres/migrator.js" "${drizzle_target}/node_modules/drizzle-orm/node-postgres/migrator.js"; \
      mkdir -p "${standalone}/apps/${APP}/node_modules"; \
      ln -s "../../../node_modules/.pnpm/$(basename "${drizzle_target}")/node_modules/drizzle-orm" "${standalone}/apps/${APP}/node_modules/drizzle-orm"; \
      ln -s "../../../node_modules/.pnpm/$(basename "${pg_target}")/node_modules/pg" "${standalone}/apps/${APP}/node_modules/pg"; \
    fi
# Railway runs the migration in the standalone runner before the application
# starts. Compile its TypeScript entrypoint during the image build so that
# pre-deploy can execute it with Node without shipping the tsx dev tool.
RUN if [ "${APP}" = "web" ]; then \
      set -eux; \
      migration_runtime="apps/${APP}/.next/migration-runtime"; \
      pnpm exec tsc "apps/${APP}/src/server/db/migrate.ts" \
        --target ES2022 \
        --module ESNext \
        --moduleResolution bundler \
        --skipLibCheck \
        --outDir "${migration_runtime}"; \
      mv "${migration_runtime}/migrate.js" "${migration_runtime}/migrate.mjs"; \
    fi

FROM node:22.16.0-alpine AS runner
ENV NODE_ENV=production
WORKDIR /app
ARG APP=web
ENV APP=${APP}
COPY --from=builder /app/apps/${APP}/.next/standalone ./
COPY --from=builder /app/apps/${APP}/.next/static ./apps/${APP}/.next/static
COPY --from=builder /app/apps/${APP}/public ./apps/${APP}/public
# Railway's builder accepts standard COPY stages but not BuildKit's
# RUN --mount=from=<stage>. These files are needed only by the pre-deploy
# migration command and remain inside the server-side standalone artifact.
COPY --from=builder /app/apps/${APP}/src/server/db/migrate.ts ./apps/${APP}/src/server/db/migrate.ts
COPY --from=builder /app/apps/${APP}/.next/migration-runtime/migrate.mjs ./apps/${APP}/src/server/db/migrate.mjs
COPY --from=builder /app/apps/${APP}/drizzle ./apps/${APP}/drizzle
EXPOSE 3000
ENV PORT=3000 HOSTNAME=0.0.0.0
CMD ["sh", "-c", "node apps/${APP}/server.js"]
