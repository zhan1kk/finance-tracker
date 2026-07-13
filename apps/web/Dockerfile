# Build from the repo root: docker build -f apps/web/Dockerfile .
FROM node:22-slim AS build
RUN npm install -g pnpm@10
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/web/package.json apps/web/package.json
RUN pnpm install --frozen-lockfile --filter web
COPY apps/web apps/web
# Rewrites are resolved at build time; API_URL is where /api/* is proxied to.
ARG API_URL=http://api:3000
ENV API_URL=$API_URL
RUN cd apps/web && pnpm build

FROM node:22-slim
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static apps/web/.next/static
COPY --from=build /repo/apps/web/public apps/web/public
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
