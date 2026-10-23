# Build from repo root: docker compose build gateway
FROM node:22-bookworm-slim
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.33.4 --activate \
  && useradd -u 10001 -m scad
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY apps/gateway apps/gateway
COPY apps/control-plane apps/control-plane
COPY packages/shared packages/shared
RUN pnpm install --frozen-lockfile --filter @scad/gateway...
USER scad
ENV PORT=8080
EXPOSE 8080
WORKDIR /app/apps/gateway
CMD ["pnpm", "exec", "tsx", "src/server.ts"]
