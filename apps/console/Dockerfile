# syntax=docker/dockerfile:1.7
FROM node:24-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json tsconfig.base.json ./
COPY packages ./packages
COPY apps/console ./apps/console
RUN --mount=type=cache,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile --filter @assoflow/console...
RUN pnpm turbo run build --filter=@assoflow/console...

# Fichiers statiques servis par nginx non privilégié (port 8080)
FROM nginxinc/nginx-unprivileged:1.29-alpine
COPY apps/console/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/console/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/ >/dev/null || exit 1
