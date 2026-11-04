# One image for api, worker, scheduler and the one-shot jobs; only the api serves /app/web (D88). Build context is the repository root:
#   docker build -f adapters/fly/Dockerfile .

FROM node:22.23.4-slim AS build
RUN npm install --global pnpm@12.15.0
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile --filter @hostmark/adapter-fly... --filter @hostmark/web...
RUN pnpm --filter @hostmark/adapter-fly build
# The SPA and the prerendered pages. The RUM attributes are baked in (D85) and must come from the closed lists.
ARG HOSTMARK_PLATFORM=fly
ARG HOSTMARK_VARIANT=portable
ARG HOSTMARK_TOPOLOGY=single
ARG HOSTMARK_REGION=frankfurt
ENV HOSTMARK_PLATFORM=$HOSTMARK_PLATFORM HOSTMARK_VARIANT=$HOSTMARK_VARIANT \
    HOSTMARK_TOPOLOGY=$HOSTMARK_TOPOLOGY HOSTMARK_REGION=$HOSTMARK_REGION
RUN pnpm --filter @hostmark/web build
# Production dependencies of the adapter, straight from the lockfile: only the jSquash packages, whose .wasm files
# the Node loader resolves at runtime. Everything else is inside the bundles (see build.mjs).
RUN pnpm --filter @hostmark/adapter-fly deploy --prod --frozen-lockfile /deploy

FROM node:22.23.4-slim AS runtime
ARG APP_VERSION=dev
ENV NODE_ENV=production \
    APP_VERSION=$APP_VERSION
WORKDIR /app
COPY --from=build /deploy/node_modules ./node_modules
COPY --from=build /repo/adapters/fly/dist ./dist
COPY --from=build /repo/packages/db/drizzle ./drizzle
COPY --from=build /repo/apps/web/dist ./web
USER node
CMD ["node", "--enable-source-maps", "dist/api.js"]
