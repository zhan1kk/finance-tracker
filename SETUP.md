# Setting it up on your own computer

This guide assumes you have never used a terminal. Every command is one you can
copy and paste. There is nothing to code.

Budget about **30 minutes**, most of which is downloads waiting to finish.

When you are done you will have the app running at `http://localhost:3001` on
your own machine, with your data in a database on your own machine, and you will
be able to choose — per import — whether Claude or a local model does the
categorizing.

**Nothing here costs money unless you choose the Claude option in Step 6.**

---

## Contents

1. [What you need to install](#step-1--install-the-tools)
2. [Download the code](#step-2--download-the-code)
3. [Create your settings file](#step-3--create-your-settings-file)
4. [Start the database](#step-4--start-the-database)
5. [Create the tables](#step-5--create-the-tables)
6. [Choose how transactions get categorized](#step-6--choose-how-transactions-get-categorized)
7. [Start the app](#step-7--start-the-app)
8. [Log in and look around](#step-8--log-in-and-look-around)
9. [Import your first statement](#step-9--import-your-first-statement)
10. [Troubleshooting](#troubleshooting)
11. [Keeping it running](#keeping-it-running)
12. [Optional extras](#optional-extras)

---

## Step 1 — Install the tools

Four things. If you already have one, skip it.

| What                    | Why you need it                                    |
| ----------------------- | -------------------------------------------------- |
| **Docker Desktop**      | Runs the database. You never have to configure it. |
| **Node.js 22 or newer** | Runs the app itself.                               |
| **pnpm**                | Installs the app's dependencies.                   |
| **Git**                 | Downloads the code.                                |

You will need roughly **3 GB** of free disk space, plus another **3–9 GB** if you
choose the local-model option in Step 6.

### macOS

1. **Docker Desktop** — download from
   [docker.com/products/docker-desktop](https://www.docker.com/products/docker-desktop/),
   open the `.dmg`, drag Docker to Applications, then **launch it**. Wait until
   the whale icon in the menu bar stops animating.
   Pick the Apple Silicon build if your Mac is M1 or newer, Intel otherwise.
2. **Node.js** — download the **LTS** installer from
   [nodejs.org](https://nodejs.org/) and run it.
3. **Git** — open Terminal (Cmd+Space, type "Terminal") and run `git --version`.
   macOS will offer to install the developer tools; accept. That is all it takes.
4. **pnpm** — in Terminal:
   ```bash
   corepack enable
   ```

### Windows

1. **Docker Desktop** — download from
   [docker.com/products/docker-desktop](https://www.docker.com/products/docker-desktop/)
   and run the installer. Say yes when it offers to enable WSL2; reboot if asked.
   **Launch Docker Desktop** and wait for it to say "Engine running".
2. **Node.js** — download the **LTS** Windows installer from
   [nodejs.org](https://nodejs.org/) and run it, accepting the defaults.
3. **Git** — download from [git-scm.com](https://git-scm.com/download/win) and run
   the installer, accepting the defaults.
4. **pnpm** — open **PowerShell** (Start menu, type "PowerShell") and run:
   ```powershell
   corepack enable
   ```

> Use **PowerShell** for every command in this guide, not the old Command Prompt.

### Linux

```bash
# Docker (Debian/Ubuntu)
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER   # then log out and back in

# Node.js 22 via nvm
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
# close and reopen the terminal, then:
nvm install 22

# pnpm
corepack enable
```

### Check it worked

Run these four. Each should print a version number.

```bash
docker --version
node --version     # must say v22 or higher
pnpm --version
git --version
```

If `pnpm` is not found, use this instead and try again:

```bash
npm install -g pnpm
```

---

## Step 2 — Download the code

Pick where it should live — your home folder is fine.

```bash
cd ~
git clone https://github.com/zhan1kk/finance-tracker.git
cd finance-tracker
pnpm install
```

`pnpm install` takes a couple of minutes and prints a lot. That is normal.

> **Stay in this folder for the rest of the guide.** Every command below assumes
> you are inside `finance-tracker`. If you open a new terminal later, run
> `cd ~/finance-tracker` first.

---

## Step 3 — Create your settings file

The app reads its settings from a file called `.env`. It does not exist yet —
you copy the example and edit it.

```bash
cp apps/api/.env.example apps/api/.env
```

On Windows PowerShell:

```powershell
Copy-Item apps/api/.env.example apps/api/.env
```

Now generate a random password for signing your logins:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

That prints a long string of letters and numbers. **Copy it.**

Open `apps/api/.env` in any text editor (TextEdit, Notepad, VS Code) and find
this line:

```
JWT_SECRET="replace-me-with-a-long-random-string"
```

Replace the text inside the quotes with what you just copied, so it looks like:

```
JWT_SECRET="8f3a9c...the long string you generated..."
```

Save the file. Leave everything else alone for now — you will come back in
Step 6.

> **This file holds your secrets and is never uploaded anywhere.** Git is already
> configured to ignore it.

---

## Step 4 — Start the database

Make sure Docker Desktop is running, then:

```bash
docker compose up -d db
```

That downloads PostgreSQL the first time (about 400 MB) and starts it in the
background. It listens on port **5433**, deliberately not the usual 5432, so it
cannot clash with a database you already had.

Check it started:

```bash
docker compose ps
```

You should see one row for `db` with status `Up` or `healthy`.

**You only run this once.** Docker restarts it automatically when your computer
boots.

---

## Step 5 — Create the tables

The database is empty. These build its structure and add the starting
categories.

```bash
pnpm --filter api exec prisma migrate deploy
pnpm --filter api exec prisma generate
pnpm --filter api exec prisma db seed
```

The last one prints something like `Seeded demo@local.test`. That is a demo
login you can use immediately:

- **Email:** `demo@local.test`
- **Password:** `changeme123`

Change that password once you are in, or register your own account.

---

## Step 6 — Choose how transactions get categorized

This is the interesting decision. When you import a statement, something has to
look at "REWE CITY 4471" and decide it is Groceries.

Three options, and you can have more than one installed and switch between them
per import.

|                             | **Claude**                                 | **Local model (Ollama)**   | **Keywords only**          |
| --------------------------- | ------------------------------------------ | -------------------------- | -------------------------- |
| Accuracy on real statements | very good                                  | mixed                      | poor                       |
| Cost                        | about $0.05–$0.30 per statement            | free                       | free                       |
| Your data                   | descriptions and amounts sent to Anthropic | never leaves your computer | never leaves your computer |
| Extra disk space            | none                                       | 3–9 GB                     | none                       |
| Setup effort                | 5 minutes                                  | 10 minutes + a download    | none, already works        |

Those accuracy and cost figures are measured on this project against real bank
statements, not estimates.

> **Read this even if you pick Claude:** importing **PDF** statements always uses
> the local model, whichever categorizer you choose, because reading a PDF means
> sending the whole page — balances and account numbers included — and that stays
> on your machine on purpose. The dashboard's written summary and the
> "who owes whom" reminder detection are local for the same reason.
>
> **If you skip Ollama, CSV imports work fine but PDF imports will not.**

### Option A — Claude

1. Go to [console.anthropic.com](https://console.anthropic.com/) and sign up.
   This is the developer console, not the Claude chat app — a Claude Pro
   subscription does **not** include API access, they are billed separately.
2. Click **Billing** in the sidebar and add credit. The minimum is **$5**, which
   at measured rates is roughly 20–100 statements.
3. Click **API keys** → **Create Key**. Give it any name.
4. **Copy the key immediately.** It starts with `sk-ant-` and is shown exactly
   once. If you lose it, delete it and make a new one.
5. Open `apps/api/.env` and find these lines:
   ```
   # ANTHROPIC_API_KEY=""
   # CATEGORIZER="anthropic"
   ```
   Remove the `#` and the space at the start of each, and paste your key in:
   ```
   ANTHROPIC_API_KEY="sk-ant-your-key-here"
   CATEGORIZER="anthropic"
   ```
6. Save the file.

`CATEGORIZER` only sets which option is **pre-selected**. You can still pick a
different one for any individual import.

### Option B — Ollama (local model)

Ollama runs an AI model on your own computer. Nothing is sent anywhere.

1. **Install it.**
   - macOS and Windows: download from
     [ollama.com/download](https://ollama.com/download) and run the installer.
     It adds a small icon to the menu bar / system tray and starts automatically.
   - Linux: `curl -fsSL https://ollama.com/install.sh | sh`
2. **Download a model.** Pick by how much RAM your computer has:

   | Your RAM      | Command                   | Download     |
   | ------------- | ------------------------- | ------------ |
   | 8 GB          | `ollama pull qwen3:4b`    | about 2.5 GB |
   | 16 GB         | `ollama pull qwen2.5:7b`  | about 4.7 GB |
   | 32 GB or more | `ollama pull qwen2.5:14b` | about 9 GB   |

   Bigger is noticeably better here. Use the largest your RAM allows.

3. **Check it works:**

   ```bash
   ollama run qwen2.5:7b "say hello"
   ```

   It should reply. Type `/bye` to exit. The first run is slow because the model
   is loading into memory.

4. Open `apps/api/.env`, uncomment these two lines and set the model to whichever
   one you pulled:
   ```
   OLLAMA_MODEL="qwen2.5:7b"
   CATEGORIZER="ollama"
   ```

### Option C — both (recommended)

Do Option A **and** Option B. Set `CATEGORIZER` to whichever you want as the
default. Both then appear in a dropdown on the import screen, and you can switch
per import — which is also how you compare them on the same statement.

### Option D — neither

Skip this step entirely. CSV import still works; every row lands in the review
queue for you to categorize by hand. Each correction is remembered as a rule, so
it gets faster as you go. PDF import will not work.

---

## Step 7 — Start the app

```bash
pnpm dev
```

Leave this terminal window **open** — closing it stops the app. It prints logs
continuously; that is normal.

Look for a line like this near the top:

```
[CategorizationProvider] Imports categorize with Claude (claude-sonnet-5)
  unless one asks otherwise — row descriptions and amounts leave this machine
```

**That line is worth reading.** It tells you exactly which categorizer is live.
If it says something you did not expect, your `.env` edit did not take — see
[Troubleshooting](#troubleshooting).

Now open **<http://localhost:3001>** in your browser.

To stop the app later, click that terminal and press **Ctrl+C**. To start it
again, `cd ~/finance-tracker` and `pnpm dev`.

---

## Step 8 — Log in and look around

Log in with `demo@local.test` / `changeme123`, or click Register to make your own
account.

A short guided tour starts on first login. Take it — it covers each page in
about a minute.

Then do this much before importing anything:

1. **Accounts** → add each place your money actually lives: a bank, a card, cash.
   Set the starting balance to what it is right now.
2. **Categories** → the defaults are generic. Rename them to match how you
   actually think about your spending. This matters more than it sounds: the
   categorizer picks from _your_ list, and a list of categories that mean
   something to you produces much better guesses than a generic one.

---

## Step 9 — Import your first statement

1. Export a statement from your bank as **CSV** (most banks have this under
   Statements or Transactions → Export). PDF also works if you installed Ollama.
2. **Imports** → pick the account → choose the file.
3. If it is a CSV, tell it which columns hold the date, the amount and the
   description. It shows you an example row so you can check. It remembers this
   per account, so you only do it once per bank.
4. Pick your categorizer from the **Categorize with** dropdown, if you set up
   more than one.
5. Click **Import**.

You land on a review screen. Rows the categorizer was confident about are marked
**Ready**. Rows it was unsure about wait for you. Fix anything wrong — **every
correction is remembered as a rule**, so that merchant is automatic next time.

Nothing touches your balances until you press **Import ready**. If you press it
and regret it, **Undo** reverses the whole batch.

### Some things it does that are not obvious

- **Re-importing the same statement is safe.** Duplicates are detected and
  skipped, not double-counted.
- **Reverted and declined card holds are dropped on purpose** — no money moved.
  The screen names any row it left out and why.
- **Transfers between your own accounts** count as neither income nor spending.
  Mark one and it learns the pattern.
- **Reversal pairs get flagged** — a charge and its refund a few days later are
  pointed out so you can skip both.

### Checking which model actually ran

The import review screen says `categorized by anthropic` (or `ollama`, or
`heuristic`) under the filename. The **accuracy card** on the Imports page shows,
per import, which provider and model ran, how long it took, how many rows, and
how many of its guesses you kept.

Trust that display over what you think your `.env` says. On this project a
misconfigured deployment ran eleven imports on the wrong provider for a month
because nothing was showing which one was live.

---

## Troubleshooting

### `Environment validation failed: JWT_SECRET must be set`

You skipped Step 3, or edited the wrong file. It must be `apps/api/.env` — not
`.env.example`, and not a `.env` in the project root.

### `Cannot connect to the Docker daemon` / `docker: command not found`

Docker Desktop is not running. Open it and wait for the whale icon to settle,
then retry.

### `port is already allocated` on 5433

Something else is on that port. Find and stop it, or change `5433` in
`docker-compose.yml` **and** the port in `DATABASE_URL` inside `apps/api/.env` to
something else like `5434`.

### `Can't reach database server at localhost:5433`

The database container is not up. Run `docker compose up -d db`, then
`docker compose ps` to confirm.

### `The column ... does not exist in the current database`

You updated the code but not the database. Run:

```bash
pnpm --filter api exec prisma migrate deploy
```

### Claude fails with `401` or `authentication_error`

The key is wrong, was revoked, or was pasted with a stray character. Make a fresh
one at [console.anthropic.com](https://console.anthropic.com/) and paste it
carefully. You can check a key without leaving the terminal:

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://api.anthropic.com/v1/messages \
  -H "x-api-key: sk-ant-your-key-here" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{"model":"claude-sonnet-5","max_tokens":1,"messages":[{"role":"user","content":"hi"}]}'
```

`200` means the key works. `401` means it does not.

### Claude fails with `credit balance is too low`

Add credit under Billing in the Anthropic console.

### Ollama: everything lands in the review queue with no suggestion

Ollama is not running or the model name is wrong. Check:

```bash
ollama list     # is your model in this list?
ollama ps       # is the server running?
```

The name in `apps/api/.env` must match the `ollama list` output exactly,
including the tag after the colon.

### The first import is very slow, then later ones are fast

Normal. The model has to load into memory the first time. Ollama keeps it
resident for a couple of minutes afterwards.

### PDF import fails but CSV works

PDF reading needs Ollama, even if Claude is doing your categorizing. See Option B
in Step 6.

### Local model puts everything in one wrong category

The classic small-model failure. Try a bigger model. If you cannot, use keywords
only and let your corrections build up rules — after a few statements most rows
are handled by rules and the model barely matters.

### `pnpm: command not found`

```bash
npm install -g pnpm
```

Then close and reopen your terminal.

---

## Keeping it running

**Day to day:** open a terminal, `cd ~/finance-tracker`, `pnpm dev`. The database
starts itself with Docker.

**Updating to a newer version:**

```bash
cd ~/finance-tracker
git pull
pnpm install
pnpm --filter api exec prisma migrate deploy
pnpm dev
```

Your `.env` and your data are untouched by updates.

**Backing up** — do this occasionally, the file is small:

```bash
docker compose exec db pg_dump -U postgres finance_tracker > backup.sql
```

Restore it with:

```bash
docker compose exec -T db psql -U postgres finance_tracker < backup.sql
```

There is also an in-app export: **Accounts → Download JSON**, or the CSV export
on the Transactions page.

---

## Optional extras

### Telegram quick-capture

Log spending by texting a bot: `40 - dining out - lunch with friends`.

1. Message [@BotFather](https://t.me/BotFather) on Telegram, send `/newbot`,
   follow the prompts, and copy the token it gives you.
2. Put it in `apps/api/.env` as `TELEGRAM_BOT_TOKEN="..."` and restart the app.
3. In the app: **Accounts → Telegram**, pick a default account, generate a link
   code, and send `/link <code>` to your bot.

The bot also sends payment reminders and answers `/due` with what is coming up.
No public URL needed — it polls Telegram rather than being called.

### Only let invited people register

If you put this on the internet, set `INVITE_CODE` to any phrase. Registration
then requires it. Leave it unset and anyone who finds the URL can sign up.

### Running it on a server, 24/7

The repo ships production Dockerfiles and automatic HTTPS via Caddy. See the
[Deploying section of the README](README.md#deploying-self-hosted-247). You need
a small VPS and a domain name.

---

## Where your data goes

Worth being precise about, since it is the reason to self-host.

**Stays on your machine, always:** every transaction, balance, account, budget
and rule — all in the PostgreSQL container on your computer. PDF statement text.
The dashboard's written summary. Reminder detection. Your login credentials.

**Leaves your machine, only if you choose Claude, and only this:** each row's
description, amount, and whether it is money in or out. That is the entire
prompt. Not your balances, not account numbers, not dates, not your email.

**Never leaves, under any setting:** anything at all if you use the local model
or keywords only.

Descriptions do contain merchant names, and for transfers they contain people's
names. If that matters to you, use Option B.
