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

## Telegram quick-capture (optional)

Log spending by messaging a Telegram bot. Fields are separated by ` - `:

```
40 - dining out - lunch with friends        expense, dated today
+2000 - salary - july                       income
12.50 - groceries - snacks - 09.07          explicit date (DD.MM, DD.MM.YYYY or YYYY-MM-DD)
```

Setup:

1. Create a bot with [@BotFather](https://t.me/BotFather) and put its token in
   `apps/api/.env` as `TELEGRAM_BOT_TOKEN` (unset = bot disabled).
2. Restart the API — it long-polls Telegram, so no public URL is needed.
3. In the web app (Accounts page → Telegram): pick a default cash account,
   generate a link code, and send `/link <code>` to your bot.

Captures are booked to your default account — switch it anytime with
`/account` in the chat. Every confirmation message has an Undo button.

## Deploying (self-hosted)

The repo ships production Dockerfiles and a compose profile. On any Docker
host (small VPS is plenty):

```bash
# one-time: strong secret for signing tokens
export JWT_SECRET="$(openssl rand -hex 32)"
# optional: TELEGRAM_BOT_TOKEN, ANTHROPIC_API_KEY, WEB_PORT (default 3001)

docker compose --profile prod up -d --build
```

That runs Postgres, the API (migrations apply automatically on start; **not**
exposed to the host), and the web app — the single public entrypoint on
`WEB_PORT`. Put a TLS reverse proxy (Caddy, Traefik, nginx) in front of the
web port; the API already trusts `X-Forwarded-*` in production, cookies are
`Secure`, security headers (helmet) are on, auth routes are rate-limited, and
Swagger is disabled.

The plain `docker compose up -d db` dev workflow is unchanged. For backups on
a server, cron the `pg_dump` below.

## Backups & data export

- **In-app:** Accounts page → "Your data" → Download JSON (everything you own,
  minus credentials) or the transactions CSV.
- **Database:** `docker compose exec db pg_dump -U postgres finance_tracker > backup.sql`
  (restore with `psql -U postgres finance_tracker < backup.sql`).

## Budgets & reports

- `/budgets` — monthly spending limits per subcategory or whole category, with
  live progress (spending is net of reimbursements) and over-budget flags.
  Managed from the Budgets page; resets each calendar month.
- `GET /reports/net-worth?months=N` — net worth by month (shown on the
  overview); `GET /reports/transactions.csv` — full transaction export (also
  available via the Export CSV button on the transactions page).

## Recurring transactions

Rent, salary, subscriptions and installments post themselves on a schedule.

- `/recurring` — CRUD for recurring rules (type, amount, account, category,
  cadence DAILY/WEEKLY/MONTHLY/YEARLY × an interval, start date, optional end
  date, optional installment count). Rules can be paused/resumed.
- A daily cron (`@nestjs/schedule`) posts every due occurrence; `POST
  /recurring/run` triggers it on demand. Catch-up after downtime is handled, the
  schedule is month-end-anchored (no drift), and rules deactivate automatically
  at their end date or installment count. Generated transactions link back to
  their rule and each run updates the account balance atomically.

## CSV import & categorization (optional LLM)

Import a bank/card statement and have transactions categorized automatically.

- `POST /imports/inspect` — `{ csv }`; returns detected headers + a sample so a
  column mapping can be built.
- `POST /imports` — `{ accountId, filename, csv, mapping?, threshold? }`; stages
  and categorizes the rows into a review batch. The mapping (which columns are
  date/amount/description, date format, decimal separator) is remembered per
  account, so later imports can omit it.
- `PATCH /imports/:id/rows/:rowId` — correct a row's category (the correction is
  learned as a rule on commit).
- `POST /imports/:id/commit` — atomically create transactions for the resolved
  rows; `POST /imports/:id/undo` reverses the whole batch.
- `GET /imports/stats/accuracy` — categorization accuracy over time.
- `/rules` — CRUD for merchant → subcategory rules.

**How categorization works:** a rules pre-pass (your own + auto-learned merchant
rules) runs first, then the remaining rows go to the configured provider. Without
`ANTHROPIC_API_KEY` the provider only matches a transaction to a subcategory whose
name literally appears in the description; everything else is left for you to
categorize in the review queue (and your choice becomes a rule). Set
`ANTHROPIC_API_KEY` to enable the LLM for the rows rules don't cover — predictions
at/above the confidence threshold are auto-applied, the rest land in review.
Re-uploading the same statement is de-duplicated, not double-counted.

## Testing

```bash
pnpm --filter api test        # unit tests
pnpm --filter api test:e2e    # e2e tests (uses the finance_tracker_test database)
```

The e2e suite pushes the schema into a separate `finance_tracker_test` database and
truncates it between test files, so your dev data is untouched.
