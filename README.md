# Finance Tracker

Personal finance tracker: accounts, categorized transactions, and (eventually) smart
statement imports, budgets, and reports. See [PLAN.md](PLAN.md) for the roadmap.

## Stack

- **Monorepo:** pnpm workspaces + Turborepo
- **API:** NestJS 11 + Prisma 6 + PostgreSQL (`apps/api`, port 3000)
- **Web:** Next.js + Tailwind + TanStack Query (`apps/web`, port 3001; proxies
  the API under `/api/*` so auth cookies stay same-origin)

All money values are stored and transferred as **integers in minor currency units**
(cents), never floats.

## Getting started

Requirements: Node 22+, pnpm 10, Docker.

```bash
pnpm install

# create the local env file
cp apps/api/.env.example apps/api/.env

# start PostgreSQL (exposed on host port 5433)
docker compose up -d db

# apply migrations + generate the Prisma client
pnpm --filter api exec prisma migrate dev

# seed default subcategories
pnpm --filter api exec prisma db seed

# run API (http://localhost:3000) and web app (http://localhost:3001)
pnpm dev
```

Interactive API docs (Swagger) are served at <http://localhost:3000/docs>.

The API reads `DATABASE_URL` and `JWT_SECRET` from `apps/api/.env`
(see `apps/api/.env.example`; the compose database listens on host port **5433**).

## Authentication

All endpoints except `/health` and `/auth/*` require a Bearer access token.

- `POST /auth/register` — `{ email, password, baseCurrency? }`; seeds default
  subcategories and returns `{ accessToken, user }` plus an httpOnly refresh cookie.
- `POST /auth/login` — same response shape.
- `POST /auth/refresh` — rotates the refresh cookie, returns a fresh access token.
- `POST /auth/logout` — revokes the refresh token.
- `GET /auth/me` — current profile.

The seed script creates a demo login: `demo@local.test` / `changeme123`.

## Testing

```bash
pnpm --filter api test        # unit tests
pnpm --filter api test:e2e    # e2e tests (uses the finance_tracker_test database)
```

The e2e suite pushes the schema into a separate `finance_tracker_test` database and
truncates it between test files, so your dev data is untouched.
