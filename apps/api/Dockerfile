# syntax=docker/dockerfile:1.7
# Image unique API + worker (APP_ROLE choisit le point d'entrée). Construite depuis la racine du dépôt.
FROM node:24-alpine AS base
RUN corepack enable
WORKDIR /repo

FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json tsconfig.base.json ./
COPY packages ./packages
COPY apps/api ./apps/api
RUN --mount=type=cache,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile --filter @assoflow/api...
RUN pnpm turbo run build --filter=@assoflow/api...
RUN pnpm --filter @assoflow/api deploy --legacy --prod /out

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN apk add --no-cache tini
COPY --from=build --chown=node:node /out ./
COPY --from=build --chown=node:node /repo/packages/db/migrations ./migrations
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --retries=3 CMD wget -qO- http://127.0.0.1:3000/health/live || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["sh", "-c", "if [ \"$APP_ROLE\" = worker ]; then exec node dist/main.worker.js; else exec node dist/main.api.js; fi"]
