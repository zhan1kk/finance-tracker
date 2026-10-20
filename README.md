# Finance Tracker

Self-hosted personal finance tracker: accounts, categorized transactions,
statement imports with LLM categorization, budgets, reminders and reports.

> ### 👉 New here? Read **[SETUP.md](SETUP.md)** instead.
>
> It walks through the whole thing from nothing — installing Docker, getting a
> Claude API key, downloading a local model — assuming no terminal experience.
> This README is the reference for people who already know their way around.

See [PLAN.md](PLAN.md) for the roadmap.

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

# create the local env file, then set JWT_SECRET in it
cp apps/api/.env.example apps/api/.env

# start PostgreSQL (exposed on host port 5433)
docker compose up -d db

# apply migrations + generate the Prisma client
pnpm --filter api exec prisma migrate deploy
pnpm --filter api exec prisma generate

# seed default subcategories + a demo login
pnpm --filter api exec prisma db seed

# run API (http://localhost:3000) and web app (http://localhost:3001)
pnpm dev
```

Interactive API docs (Swagger) are served at <http://localhost:3000/docs>.

The API reads `DATABASE_URL` and `JWT_SECRET` from `apps/api/.env`
(see `apps/api/.env.example`; the compose database listens on host port **5433**).

Categorization is optional and off by default — set `ANTHROPIC_API_KEY` for
Claude, or run Ollama for a local model. See
[CSV import & categorization](#csv-import--categorization-optional-llm) below,
or [SETUP.md](SETUP.md) for the step-by-step version.

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

Log spending by messaging a Telegram bot. Fields are separated by `-`:

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

## Deploying (self-hosted, 24/7)

The repo ships everything for a turnkey deploy: production Dockerfiles, a
compose `prod` profile, and Caddy for **automatic HTTPS**. You need a Docker
host (a small VPS is plenty) and a domain pointed at it.

**1. Point a domain at the server.** Add a DNS `A` record for your domain (or a
free subdomain from e.g. [DuckDNS](https://www.duckdns.org)) to the server's IP.

**2. Create a `.env` file** next to `docker-compose.yml`:

```bash
JWT_SECRET=<paste `openssl rand -hex 32`>   # signs login tokens (required)
DOMAIN=finance.example.com                  # your domain (required)
TZ=Asia/Almaty                              # your timezone (dates "today" correctly)
POSTGRES_PASSWORD=<a strong password>       # recommended
TELEGRAM_BOT_TOKEN=<from @BotFather>        # optional — enables the bot
ANTHROPIC_API_KEY=<from console.anthropic.com>  # optional — enables LLM categorization
```

**3. Launch:**

```bash
docker compose --profile prod up -d --build
```

Caddy fetches a TLS certificate automatically and your app is live at
`https://<DOMAIN>`. The stack is Caddy → web → API → Postgres; **only Caddy is
exposed** (ports 80/443), Postgres is bound to localhost, the API trusts
`X-Forwarded-*`, cookies are `Secure`, helmet headers are on, auth routes are
rate-limited, Swagger is off, and migrations apply automatically on start.

> Telegram uses long polling, so run the bot in **one** place at a time — once
> it's live on the server, stop the local instance (they'd otherwise conflict).

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
- `POST /imports` — `{ accountId, filename, csv, mapping?, threshold?, categorizer? }`;
  stages and categorizes the rows into a review batch. The mapping (which columns
  are date/amount/description, date format, decimal separator) is remembered per
  account, so later imports can omit it.
- `POST /imports/pdf` — `{ accountId, filename, pdfBase64, categorizer? }`; a model
  reads the statement into rows, which then flow through the same pipeline.
  `PDF_EXTRACTOR` picks the reader, separately from the categorizer: a local
  Ollama model by default, so nothing leaves the machine, or `anthropic`, which
  sends the whole statement text to Claude. It is never inferred from an API key
  being present. A statement that comes back incomplete fails the import, rather
  than keeping the rows that did arrive.
- `GET /imports/categorizers` — which providers this server can run, which is the
  default, and which sends data off the machine.
- `PATCH /imports/:id/rows/:rowId` — correct a row's category (the correction is
  learned as a rule on commit).
- `POST /imports/:id/commit` — atomically create transactions for the resolved
  rows; `POST /imports/:id/undo` reverses the whole batch.
- `GET /imports/stats/accuracy` — categorization accuracy over time.
- `/rules` — CRUD for merchant → subcategory rules.

**How categorization works:** two layers, not three. A rules pre-pass (your own
plus rules auto-learned from your corrections) runs first and never involves a
model. Whatever it does not match goes to one categorization provider:

| `CATEGORIZER` | Provider      | Notes                                                                                                                     |
| ------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `anthropic`   | hosted Claude | Best accuracy. Sends each row's description, amount and direction to Anthropic — nothing else. Needs `ANTHROPIC_API_KEY`. |
| `ollama`      | local model   | Nothing leaves the machine. Noticeably less accurate; use the largest model your RAM allows. Needs Ollama running.        |
| `heuristic`   | name matching | Zero config. Only matches a subcategory whose name literally appears in the description; the rest go to review.           |

`CATEGORIZER` sets the **default**. An import may name a different one
(`categorizer` in the request body, a dropdown on the import screen), which is
how two models are compared on the same statement: import, undo, import again
with the other. Each batch records the provider and model that actually ran it,
surfaced on the accuracy card — trust that over what `.env` says.

Left unset, `CATEGORIZER` is inferred: Claude if an API key is present, otherwise
the heuristic. The inference is logged at boot, loudly, because a silent one once
sent a month of imports to the wrong provider.

Predictions at/above `DEFAULT_CATEGORIZATION_THRESHOLD` (0.7) are auto-applied;
the rest land in review, and your choice there becomes a rule. Re-uploading the
same statement is de-duplicated, not double-counted.

## Testing

```bash
pnpm --filter api test        # unit tests
pnpm --filter api test:e2e    # e2e tests (uses the finance_tracker_test database)
```

The e2e suite pushes the schema into a separate `finance_tracker_test` database and
truncates it between test files, so your dev data is untouched.
