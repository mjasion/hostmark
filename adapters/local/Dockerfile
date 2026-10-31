# One image for api, worker, scheduler and the one-shot jobs. Build context is the repository root:
#   docker build -f adapters/local/Dockerfile .

FROM node:22.23.4-slim AS build
RUN npm install --global pnpm@12.15.0
# Dependency build scripts stay off (esbuild ships its binary as a platform package); skipping must not fail.
ENV pnpm_config_strict_dep_builds=false
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile --filter @hostmark/adapter-local...
RUN pnpm --filter @hostmark/adapter-local build
# Production dependencies of the adapter, straight from the lockfile: only the jSquash packages, whose .wasm files
# the Node loader resolves at runtime. Everything else is inside the bundles (see build.mjs).
RUN pnpm --filter @hostmark/adapter-local deploy --prod --frozen-lockfile /deploy

FROM node:22.23.4-slim AS runtime
ARG APP_VERSION=local
ENV NODE_ENV=production \
    APP_VERSION=$APP_VERSION
WORKDIR /app
COPY --from=build /deploy/node_modules ./node_modules
COPY --from=build /repo/adapters/local/dist ./dist
COPY --from=build /repo/packages/db/drizzle ./drizzle
USER node
CMD ["node", "--enable-source-maps", "dist/api.js"]
