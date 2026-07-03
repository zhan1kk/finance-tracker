# Finance Tracker

Personal finance tracker: accounts, categorized transactions, and (eventually) smart
statement imports, budgets, and reports. See [PLAN.md](PLAN.md) for the roadmap.

## Stack

- **Monorepo:** pnpm workspaces + Turborepo
- **API:** NestJS 11 + Prisma 6 + PostgreSQL (`apps/api`)
- **Web:** planned (`apps/web`, Next.js)

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

# run the API in watch mode (http://localhost:3000)
pnpm dev
```

Interactive API docs (Swagger) are served at <http://localhost:3000/docs>.

The API reads `DATABASE_URL` from `apps/api/.env` (see `apps/api/.env.example`;
the compose database listens on host port **5433**).

## Testing

```bash
pnpm --filter api test        # unit tests
pnpm --filter api test:e2e    # e2e tests (uses the finance_tracker_test database)
```

The e2e suite pushes the schema into a separate `finance_tracker_test` database and
truncates it between test files, so your dev data is untouched.
