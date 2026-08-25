# Build notes: personal finance tracker

Working notes for the thesis. These cover the system design, the decisions behind
it, and the problems hit while building and running it. Written for someone who
has not seen the code, so terms are explained where they first appear.

Project period: March 2026 to August 2026. 101 commits. Live at perfintrack.com
on a rented server since mid August 2026, holding real data.

---

## 1. What the system is

A personal finance tracker. It records income and spending, sorts transactions
into categories, tracks budgets per category, and reads bank statements so the
user does not have to type every row by hand. It also sends payment reminders
through a Telegram bot.

It is single tenant in spirit but multi user in fact. Every table is scoped by
user id. Two people use it today.

The design goal that shaped most decisions: the user should be able to point at
any number on screen and trace where it came from. A finance tool that produces
a figure you cannot explain is worse than a spreadsheet.

---

## 2. Stack

| Layer | Choice | Version |
|---|---|---|
| API | NestJS | 11 |
| ORM | Prisma | 6.19 |
| Database | PostgreSQL | 16 |
| Web | Next.js (App Router) | 16.2 |
| UI | React, Tailwind | React 19.2 |
| Server state | TanStack Query | 5 |
| Local LLM | Ollama running qwen3:4b | |
| Reverse proxy | Caddy | |
| Packaging | Docker Compose | |
| Monorepo | pnpm workspaces plus Turborepo | |

Two packages: `apps/api` and `apps/web`. 131 API source files, 38 web files, 19
database models, 30 migrations.

Why NestJS. It pushes you into modules, controllers, services and dependency
injection by default. On a project this size that structure is worth more than
the flexibility of a bare Express app. Modules map cleanly onto features:
accounts, transactions, budgets, imports, reminders, split, fx, telegram,
recurring, reports, auth, jobs.

Why Prisma. Migrations are plain SQL files that can be read and reviewed. The
generated client is typed, so a renamed column breaks the build rather than
production. Raw SQL is still available where the query needs it, and the stats
queries do use it.

Why Next.js. Server rendering was not the point. File based routing, one
language across both halves, and shared TypeScript types were.

---

## 3. Architecture

### 3.1 Shape

```
browser / Telegram
        |
     Caddy (TLS)
        |
   Next.js web  ->  NestJS API  ->  PostgreSQL
                         |
                      Ollama (local LLM)
```

Caddy is the only container with published ports. The API has none. Postgres is
bound to localhost. The web app proxies API calls, so the browser only ever
talks to one origin. That removes CORS entirely and keeps cookies same site.

### 3.2 Money

All money is stored as integer minor units. Cents, not floats. Floating point
cannot represent 0.1 exactly, and a finance tool that drifts by a cent per
operation is not trustworthy.

Every transaction carries two amounts:

- `amount`: the value in the account's own currency.
- `amountBase`: the same value converted to the user's base currency, using the
  exchange rate in effect on the transaction date.

Every cross account total sums `amountBase`. Stats, budgets, net worth. Without
that second column a Kazakhstani tenge account and a euro account would add up
to nonsense. The conversion is cached at write time rather than computed on read,
so a rate added later does not silently rewrite history.

### 3.3 Categories

Two levels. A fixed set of categories (Expenses, Income, Bills, Debts, Savings
and so on) and user defined subcategories underneath. The fixed level lets the
code reason about direction and meaning. The free level lets the user name things
however they like.

Three flags carry most of the domain logic:

- `excludeFromStats`: an internal move between the user's own accounts. It
  changes balances but is not income or spending.
- Reimbursement links: an expense can have a payback attached. The payback counts
  in the month of the parent expense, not its own month.
- Transfers: two legs, one movement.

These three rules touch stats, budgets and net worth. They are the part of the
system most likely to produce a wrong number, so they carry the most tests.

### 3.4 Import pipeline

The most involved part of the system.

```
upload -> parse -> stage -> dedupe -> categorize -> review -> commit
```

- **Parse.** CSV with a per account column mapping the user configures once.
  PDF goes through text extraction (Mozilla pdf.js via unpdf) and then a local
  model that reads the text into rows.
- **Stage.** Rows land in an `ImportRow` table, not in the ledger. Nothing
  reaches the real transaction table until the user confirms.
- **Dedupe.** Each row gets a hash. A row whose hash already exists in the same
  account is flagged as a duplicate and excluded. Scoped to the account on
  purpose. A false duplicate silently drops a real transaction, which is worse
  than asking.
- **Categorize.** Three passes in order: user rules, then a heuristic matcher,
  then the LLM for whatever is left.
- **Review.** The user sees every row with its suggested category and a
  confidence value. High confidence rows are marked ready. The rest need a pick.
- **Commit.** Only then do rows become transactions.

The staging table is the important design decision. It makes the import
reversible and inspectable. It also means a failed categorization degrades into
"more manual work" rather than "wrong data in the ledger".

### 3.5 Categorization providers

Three implementations behind one interface:

- **Heuristic.** Plain string matching. No model, no network, zero cost.
- **Anthropic.** Hosted model, used early in the project.
- **Ollama.** Local model. Used in production now.

The switch is one environment variable. That was deliberate. It let the same
import be run through a hosted model and a local one and compared, which is the
accuracy comparison the thesis needs.

Every provider funnels its output through one shared function that validates it.
A category id the user does not own becomes null. Confidence is clamped to 0 to
1. A row the model skipped falls back to null. Model output is untrusted input
and is treated like any other untrusted input.

### 3.6 Reminders and the bot

Reminders are payment due dates. Some are one off. Some repeat on a cadence. Some
are fixed installment plans with a known count, like a television paid over
twelve months.

A daily job nudges the user through Telegram. The schedule is user configurable:
a lead time in days and an interval. A lead of 10 and an interval of 5 pings at
10, 5, 1 and 0 days out. The day before and the due day always ping regardless of
the arithmetic, because those are the two that matter.

Overdue reminders deliberately go silent. A daily nag about a bill you already
know about is worse than none. That decision has a cost, covered in the problems
section.

### 3.7 Background work

A small in process job registry. Long operations return a job id immediately and
the client polls. Used for statement imports and reminder scans. No queue, no
worker process. At this scale that would be infrastructure for its own sake.

---

## 4. Deployment

A Hetzner cloud server. Four CPUs, 8 GB RAM, no GPU. Ubuntu. One Docker Compose
file with a production profile: Caddy, web, API, Postgres, Ollama.

Caddy fetches its own TLS certificate. Migrations run automatically when the API
container starts. Deploys are a file sync followed by a rebuild.

The local model choice was constrained by that hardware. 8 GB and no GPU rules
out anything large. qwen3:4b at 2.5 GB fits. It also caused several problems,
covered below.

---

## 5. Testing

167 unit tests and 126 end to end tests at the time of writing.

Unit tests cover pure logic: money maths, date arithmetic, categorization
parsing, settlement rules, recurring detection, schedule arithmetic. Anything
that can be a pure function is one, specifically so it can be tested without a
database.

End to end tests run against a real disposable Postgres database. They exercise
the HTTP layer with a real Nest application. The database is reset before the
suite and truncated between tests.

Continuous integration runs lint, build, unit tests, end to end tests, then the
same for the web package.

---

## 6. Problems faced

This is the honest list. Several of these were self inflicted.

### 6.1 Prisma engine mismatch inside Docker

Symptom: the container built fine and then crashed at runtime with "could not
locate Query Engine".

Cause: `prisma generate` ran in a build stage without openssl installed. It
detected the wrong platform and downloaded an engine built against openssl 1.1.
The runtime image had openssl 3.

Fix: install openssl in the build stage before generating. Obvious in hindsight.
Cost several hours because the error appeared at runtime, far from its cause.

### 6.2 The end to end test flake

The worst debugging problem in the project.

Symptom: roughly 40% of test runs failed. A different test each time. Status 200,
404 or 401 where the route could not produce them, and sometimes a socket hang
up. The response bodies were empty.

What was ruled out first: cron schedulers, a second Postgres container,
background job work, cross suite interference, rate limiting. Each was eliminated
by removing it and re running.

The breakthrough was adding the response body to the failure message. That showed
a registration request returning 200 with no body, which that route cannot do.

Cause: the test setup handed the HTTP client a server that had been initialised
but never told to listen. The client then opened its own ephemeral port per
request and closed it after. Under a fast suite those listen and close cycles
race, and a request lands on a socket being torn down.

Fix: one line. Bind the server properly before the tests run. Sixteen consecutive
clean runs afterwards, against a 40% failure rate measured minutes earlier.

Lesson worth writing up: the diagnostic that solved it was making the failure
message carry more information. Not more logging, not more retries.

### 6.3 Blank environment variables

Symptom: the local model silently stopped working for two days. Reminder scans,
PDF extraction and summaries all failed quietly.

Cause: Docker Compose passes optional variables as `${VAR:-}`. That defines the
variable as an empty string rather than leaving it unset. JavaScript's `??`
operator does not fall back on an empty string, only on null or undefined. So the
model name arrived as `""` and every request returned HTTP 400.

Fix: one helper that reads a setting and treats blank as absent. Every optional
setting now goes through it.

This one is worth a paragraph in the thesis because the bug class is general.
Configuration that is "present but empty" defeats null checks. It was introduced
by a change made to fix something else.

### 6.4 Production outage from a build path change

Symptom: the site returned 502 after a deploy. The API container crash looped.

Cause: adding a scripts folder widened the TypeScript project root. The compiler
then emitted `dist/src/main.js` instead of `dist/main.js`. The container start
command still pointed at the old path.

Fix: exclude the scripts folder from the build config.

Two lessons. Build output layout is load bearing and invisible. And the health
check reported healthy while the old container was still serving, which made the
first diagnosis wrong.

### 6.5 A setting that was never passed through

Symptom: production was categorizing through the hosted model when it was meant
to use the local one.

Cause: the environment variable was set on the server but never declared in the
Compose file, so it never reached the container.

Fix: add the passthrough. Related to 6.3. Both are configuration reaching the
process, which is a boundary that deserves the same scrutiny as user input.

### 6.6 Cross month reimbursement misattribution

Symptom: a category showed more spending than the chart for the same month.

Cause: a reimbursement was counted in the month it arrived, not the month of the
expense it paid back. If you buy something in June and are paid back in July,
June stays overstated and July is understated.

Fix: the payback now counts against the parent expense's date. This touched the
monthly stats query, the category query and the budget query. Affected five
categories in one month by about 375 euros.

### 6.7 A seeded exchange rate that was wrong

Symptom: a category total was off by about 6 euros.

Cause: the system shipped with a built in rate for Kazakhstani tenge of 540 per
euro. The real rate on the relevant date was 566.46.

Fix: rates are now fetched per date and stored, and the user can add historical
rates. The built in values were reduced to a seed only fallback.

Design point worth keeping: a cached conversion is correct only if the rate it
used was correct. Caching moved the problem from "slow" to "wrong", which is a
worse failure mode and needed the fetch path to be right.

### 6.8 An account created in an unpriced currency

Symptom: net worth was wrong by a large margin.

Cause: creating an account with a starting balance in a currency with no rate on
file froze the base currency value at a one to one conversion. 10,000 lira became
10,000 euros.

Fix: creating an account in a new currency now ensures a rate exists first.

### 6.9 Date input firing on every keystroke

Symptom: typing a date into the rate lookup produced errors and unwanted network
requests.

Cause: a date input reports intermediate values while you type. Typing day and
month fired a fetch before the year existed. Paging through the calendar fired
one request per month passed.

Fix: an explicit button. The lesson is that "change" on a date input is not the
same event as "the user has finished choosing a date". This was my own bug,
introduced the same day.

### 6.10 Month end date arithmetic, three separate copies

Symptom: a bill due on the 31st skipped a month.

Cause: JavaScript's `setMonth` overflows silently. 31 January plus one month
becomes 31 February, which rolls into 3 March. February is skipped entirely and
the schedule is wrong from then on.

There were three implementations of this arithmetic in the codebase. One was
already correct and handled the case properly. One clamped but then drifted. One
was raw and broken.

Fix: one shared implementation. It clamps to the end of a short month and springs
back afterwards, using the original day as an anchor stored on the record.
January 31 becomes February 28, then March 31 again, not March 28.

This is the clearest example in the project of the same logic living in several
places and only some copies being right. Worth a paragraph on why duplicated
logic is a correctness problem and not only a tidiness one.

### 6.11 Two implementations of "settle this reminder"

Symptom: pressing the done button on a Telegram reminder for an installment plan
dismissed the whole plan instead of recording one payment.

Cause: the web application had one implementation that advanced installments and
rolled recurring bills forward. The Telegram handler had another that just set a
done flag. They were written at different times and never compared.

Fix: the decision moved into one pure function that both call. The bot reply also
now says what happened ("4/12 paid, next due 24 September") instead of a bare
"marked done", which would have made the bug visible from the message alone.

Same root cause as 6.10. Two implementations of one idea.

### 6.12 The local model reasoning past every timeout

Symptom: a statement import left 86 of 132 rows uncategorized.

Investigation: server logs showed four requests, each aborted exactly 120 seconds
apart. So the requests were not failing, they were timing out.

Cause: qwen3 is a hybrid reasoning model. It generates a chain of thought before
answering unless told not to. Measured on the server, asking it to "reply with the
single word: ok" produced 637 characters of hidden reasoning and took 16.7
seconds. A 25 row categorization request never had a chance in two minutes.

Fix: disable thinking, keep the model resident between requests, and set the
context size explicitly rather than relying on a 4k default.

Three other parts of the system called the same model and had the same problem.
One of them had a 30 second timeout, which could not survive 16 seconds of
thinking, so it had probably been failing quietly for weeks.

### 6.13 Batch size and accuracy

After fixing the timeouts the model ran but the answers were poor.

Measured on the server against labelled merchants:

| Rows per request | Correct | Unanswered |
|---|---|---|
| 5 | 15/15 | 0 |
| 10 | 5/15 | 10 |
| 15 | 13/15 | 0 |
| 25 | 1 answer for 25 rows | |

Reliability above five rows is erratic rather than gradually declining. Five was
correct every time. Per request overhead dominates anyway, so smaller batches
cost little.

The dangerous case is ten. It answers every row confidently and most are wrong.
That is worse than a timeout. A timeout leaves rows blank for review. Wrong
answers look like success.

### 6.14 Correct answers being discarded

The most interesting bug in the project.

After fixing 6.12 and 6.13 the results were still bad. Instrumenting the actual
requests showed the model was choosing the right categories almost every time.
The problem was elsewhere.

The system sends rows with short identifiers and expects the model to echo them
back so the answers can be matched to the rows. qwen3 does not do that reliably.
One request answered with the row id `description`. Another invented `id_1` and
`id_2`. The categories beside those ids were correct.

The matching code looked up by exact id, found nothing, and fell back to null for
the whole batch. Every correct answer was thrown away. Only the first batch of
any import ever survived.

Fix: prefer explicit ids when they match, and otherwise fall back to position,
but only when the reply contains exactly one item per row. A count mismatch means
rows were skipped or invented, and aligning those by position would file real
categories against the wrong transactions. That case still returns nulls.

Result: 5 of 12 correct before, 11 of 12 after.

Design point: an integration that depends on a small model following an
instruction exactly will fail. The protocol has to tolerate the model getting the
bookkeeping wrong while getting the answer right.

### 6.15 Continuous integration was red for the whole project

Symptom: none, which was the problem.

The pipeline had been failing since its second run, months earlier. It was
noticed by accident.

Cause: formatting drift across 35 of 155 files. Lint runs before the tests in the
pipeline. A failing lint step meant the tests behind it never ran at all. So every
push reported as verified locally while the pipeline was checking nothing.

Fix: run the formatter, then fix the eight real issues left behind, then the three
in the web package. The first fully green run in five months also ran the end to
end suite for the first time.

Lesson: verifying with the same commands the pipeline runs, in the same order.
Running build and tests locally is not the same thing.

### 6.16 A duplicate detection question that was not a bug

Worth including because the investigation mattered more than the outcome.

Symptom reported: a re imported statement no longer flagged transactions as
already present.

Investigation: checked each named merchant against the ledger. Zero matches in
any account. Compared the two statement files. Different date ranges, different
file hashes, and exactly seven fewer rows, matching the seven that had been
flagged before.

Conclusion: two different exports. The first reached one day further back and
picked up seven transactions from an earlier import. The second did not contain
them. Nothing to flag. Dedup was correct.

The lesson is about evidence. The reported symptom was reasonable and the
conclusion was wrong. Checking the data before changing code avoided breaking
something that worked.

---

## 7. Cross cutting themes

Four patterns explain most of the defects above.

**Duplicated logic diverges.** 6.10 and 6.11 are the same failure. One idea, two
or three implementations, only some correct. Every fix was to collapse them into
one function that all callers use.

**Configuration is untrusted input.** 6.3 and 6.5. A variable can be missing,
empty, or never passed through. None of those look different from the outside.

**Silent degradation is worse than failure.** 6.12, 6.13, 6.14 and 6.15 all
looked like the system working. Uncategorized rows look like an unconfident
model. A red pipeline that stops before the tests looks like a passing pipeline
if nobody checks. Anything that can fail quietly eventually will, and for a long
time.

**Caching moves problems, it does not remove them.** 6.7. Caching a converted
amount made reads fast and made a wrong rate permanent.

---

## 8. What is deliberately not there

Useful for a thesis section on scope.

- No message queue. In process jobs with client polling are enough at this size.
- No microservices. One API, one database.
- No server side rendering of authenticated data. The web app is a client that
  talks to the API.
- No per invite codes. Registration is gated by one shared secret. Per person
  invites would need a table, generation, revocation and an admin screen, for
  almost no benefit at two users.
- No hosted LLM in production. Transaction descriptions stay on the server.
  Privacy was the reason, and it is also the second data point for the accuracy
  comparison.

---

## 9. Notes on process

Some of the work was driven by a scheduled agent that read the codebase daily and
mailed a short review. It found real issues: lists that grow without bound, dates
formatted inconsistently, missing loading states, a form control with no visible
focus indicator.

It was also wrong sometimes, and those cases are instructive. It once proposed
replacing a spelled out "delete all" button with an icon for consistency, which
would have made the most destructive action on the page the easiest to hit by
accident. Another suggestion would have made a single line toolbar two lines
tall. A reviewer reading the code without seeing it rendered can spot
inconsistency but cannot judge layout.
