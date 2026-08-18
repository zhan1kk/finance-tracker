# Build from the repo root: docker build -f apps/api/Dockerfile .
FROM node:22-slim AS build
# openssl must be present BEFORE `prisma generate`, or Prisma's platform
# detection picks the wrong (openssl-1.1) query engine for the runtime image.
RUN apt-get update -y \
  && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@10
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/package.json
RUN pnpm install --frozen-lockfile --filter api
COPY apps/api apps/api
RUN cd apps/api && pnpm exec prisma generate && pnpm build

FROM node:22-slim
# Prisma's query engine needs OpenSSL at runtime.
RUN apt-get update -y \
  && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@10
ENV NODE_ENV=production
WORKDIR /repo
COPY --from=build /repo/node_modules node_modules
COPY --from=build /repo/package.json package.json
COPY --from=build /repo/apps/api/node_modules apps/api/node_modules
COPY --from=build /repo/apps/api/dist apps/api/dist
COPY --from=build /repo/apps/api/prisma apps/api/prisma
# Admin tooling (password reset) has to be runnable in the deployed container.
COPY --from=build /repo/apps/api/scripts apps/api/scripts
COPY --from=build /repo/apps/api/package.json apps/api/package.json
WORKDIR /repo/apps/api
EXPOSE 3000
# Apply pending migrations, then serve.
CMD ["sh", "-c", "pnpm exec prisma migrate deploy && node dist/main.js"]
