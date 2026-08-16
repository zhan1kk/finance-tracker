"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui";

/** localStorage flag so the tour auto-shows only on the first visit. */
export const WELCOME_SEEN_KEY = "ft:welcomeSeen";

type Step = {
  icon: string;
  title: string;
  body: string;
  example?: ReactNode;
  /** Optional depth, collapsed by default so the tour stays short. */
  details?: ReactNode;
  cta?: { href: string; label: string };
};

/** A small faux-UI snippet, so each step shows an example of the real thing. */
function Eg({ children }: { children: ReactNode }) {
  return (
    <div className="mt-3 rounded-lg border border-zinc-200 bg-zinc-50 p-3 text-sm dark:border-zinc-800 dark:bg-zinc-800/40">
      {children}
    </div>
  );
}

/**
 * Collapsed extra explanation. Native <details> so it is keyboard-accessible
 * and needs no state of its own; it re-collapses when the step changes because
 * each step renders a fresh element.
 */
function More({ children }: { children: ReactNode }) {
  return (
    <details className="group mt-3 rounded-lg border border-zinc-200 dark:border-zinc-800">
      <summary className="cursor-pointer list-none rounded-lg px-3 py-2 text-sm font-medium text-zinc-600 hover:bg-zinc-50 dark:text-zinc-300 dark:hover:bg-zinc-800/40">
        <span className="inline-block transition-transform group-open:rotate-90">
          ›
        </span>{" "}
        More details
      </summary>
      <div className="flex flex-col gap-2 px-3 pb-3 text-sm text-zinc-600 dark:text-zinc-300">
        {children}
      </div>
    </details>
  );
}

/** One labelled point inside a <More> block. */
function Point({ label, children }: { label: string; children: ReactNode }) {
  return (
    <p>
      <span className="font-medium text-zinc-800 dark:text-zinc-100">
        {label}
      </span>{" "}
      {children}
    </p>
  );
}

const STEPS: Step[] = [
  {
    icon: "👋",
    title: "Welcome to your finance tracker",
    body: "It's private: your data stays on this server and the categorization runs locally, so nothing is sent to an outside AI service. Here's a quick tour — each step has a “More details” link if you want the full story.",
  },
  {
    icon: "🏦",
    title: "Accounts",
    body: "Add every place your money lives — a bank, a card, cash, even a foreign-currency pocket. Balances update automatically as you add transactions, and you can pin the ones you check most.",
    example: (
      <Eg>
        <div className="flex items-center justify-between border-l-4 border-emerald-500 pl-2">
          <span>Revolut · bank</span>
          <span className="font-semibold tabular-nums">€1,240.00</span>
        </div>
      </Eg>
    ),
    details: (
      <>
        <Point label="Types matter a little.">
          Bank, card, cash and investment accounts behave the same day to day,
          but the type is what makes your net-worth chart meaningful. You can
          change it later from the Accounts page.
        </Point>
        <Point label="Other currencies are fine.">
          An account keeps its own currency, and every amount is also converted
          into your base currency so totals and charts add up. You control the
          rates under Exchange rates — no live market feed is required.
        </Point>
      </>
    ),
  },
  {
    icon: "💸",
    title: "Transactions",
    body: "Log spending, income, or a transfer between your own accounts, and give it a category. One charge can be split across categories, and the app quietly flags amounts that look unusual.",
    example: (
      <Eg>
        <div className="flex items-center justify-between">
          <span>SPAR · Groceries</span>
          <span className="tabular-nums">−€12.50</span>
        </div>
      </Eg>
    ),
    details: (
      <>
        <Point label="Moving your own money isn't spending.">
          When you send money from your bank to your savings, record it as a
          transfer. Both balances change, but it never shows up as income or
          expense — otherwise every transfer would look like you spent it.
        </Point>
        <Point label="One receipt, several categories.">
          A supermarket run that was half groceries and half household stuff can
          be split into parts that add up to the original amount, so each part
          lands in the right category.
        </Point>
        <Point label="Hide something from the stats.">
          Any transaction can be marked as excluded. It still changes your
          balance, but it stays out of budgets and charts — handy for a
          reimbursement you pass straight through, or a one-off that would
          distort the month.
        </Point>
      </>
    ),
  },
  {
    icon: "📥",
    title: "Import statements",
    body: "Skip the typing: upload a bank statement (CSV or PDF) and the app extracts the rows, drops duplicates, and auto-categorizes them for you to review before saving.",
    example: (
      <Eg>
        <span className="text-zinc-500">
          Upload statement → review 42 rows → commit ✓
        </span>
      </Eg>
    ),
    details: (
      <>
        <Point label="First time with a new bank: you map the columns.">
          You tell it once which column holds the date, the amount and the
          description. That mapping is remembered, so the next statement from
          the same bank goes straight through.
        </Point>
        <Point label="Nothing is saved until you say so.">
          An import always lands in a review screen first. Rows the app is
          confident about are pre-filled; the unsure ones are waiting for you to
          pick a category. You commit when the list looks right.
        </Point>
        <Point label="Re-importing an overlapping statement is safe.">
          Rows that already exist in your ledger are detected and skipped, so
          you can import January–March and then February–April without creating
          duplicates.
        </Point>
        <Point label="It learns from your corrections.">
          Every time you fix a category, that becomes a rule for that merchant.
          Next time the same shop appears it is matched instantly, without
          asking the model at all — so imports get faster and more accurate the
          more you use it.
        </Point>
      </>
    ),
  },
  {
    icon: "📊",
    title: "Overview",
    body: "Your dashboard: income vs spending for the month, a donut of where money goes, how you're trending vs your 3-month average, net worth over time, and what's due soon.",
    details: (
      <>
        <Point label="Your month doesn't have to start on the 1st.">
          If you’re paid on the 25th, set that as your month start and every
          total, budget and chart will follow your pay cycle instead of the
          calendar.
        </Point>
        <Point label="“vs average” compares like with like.">
          The trend figure measures this month against your own recent months,
          not against a target — so it tells you whether this month is unusual
          for you.
        </Point>
      </>
    ),
  },
  {
    icon: "🎯",
    title: "Budgets",
    body: "Set a monthly cap on variable spending like Dining or Groceries. A bar shows how much you've used — green under, red over.",
    example: (
      <Eg>
        <div className="mb-1 flex items-center justify-between">
          <span>Dining out</span>
          <span className="tabular-nums text-zinc-500">€180 / €200</span>
        </div>
        <div className="h-2 rounded bg-zinc-200 dark:bg-zinc-700">
          <div className="h-2 w-[90%] rounded bg-emerald-600" />
        </div>
      </Eg>
    ),
    details: (
      <>
        <Point label="Every month, or just this one.">
          A normal budget repeats. A one-off budget applies to a single month —
          right for a holiday in July that you don’t want haunting August.
        </Point>
        <Point label="Compare two months side by side.">
          Because limits change, the comparison shows each month’s spend against
          that month’s own limit, so a bigger Travel budget in summer doesn’t
          read as overspending.
        </Point>
      </>
    ),
  },
  {
    icon: "⏰",
    title: "Reminders",
    body: 'Never miss a bill. A scan reads your descriptions for upcoming payments ("1/3 payment") and IOUs ("ask Alex for their share"), and it can auto-detect recurring bills like rent.',
    example: (
      <Eg>
        <div className="flex items-center justify-between">
          <span>Rent</span>
          <span className="text-zinc-500">due in 3d · €800</span>
        </div>
      </Eg>
    ),
    details: (
      <>
        <Point label="Instalments are counted for you.">
          If a description says something like “2/6”, the app understands you’re
          two payments into six and tracks the remaining four, with the next one
          due a month later.
        </Point>
        <Point label="Recurring bills are found, not typed.">
          Detect recurring looks for charges that repeat at a steady interval —
          monthly, quarterly or yearly — and offers them as reminders. Nothing
          is created behind your back; you approve what becomes a reminder.
        </Point>
        <Point label="They fix themselves when the payment arrives.">
          If you already paid but only import the statement later, the reminder
          notices the matching transaction and moves on to the next period
          instead of nagging you about a bill you’ve settled.
        </Point>
      </>
    ),
  },
  {
    icon: "👥",
    title: "Split with friends",
    body: "Paid for a group on a trip? Record who paid and who shares it — the Split tab tallies who owes whom, even when you weren't the one who paid.",
    example: (
      <Eg>
        <div>
          <span className="font-medium">Sam</span> owes{" "}
          <span className="font-medium">You</span> €10
        </div>
        <div className="text-zinc-500">
          <span className="font-medium">You</span> owe{" "}
          <span className="font-medium">Alex</span> €6
        </div>
      </Eg>
    ),
    details: (
      <>
        <Point label="It works when someone else pays too.">
          Most trackers only handle money leaving your account. Here you can
          record that a friend paid for dinner and you owe them a share, so the
          running total between you is right either way.
        </Point>
        <Point label="Only your share hits your stats.">
          Paying €60 for three people isn’t €60 of your own spending, so the
          split keeps your categories honest.
        </Point>
      </>
    ),
  },
  {
    icon: "🔗",
    title: "Refunds that cancel out",
    body: "When money comes back to you — a returned item, or your flatmate paying you back — link it to the expense it repays. The two then cancel out instead of inflating your income.",
    example: (
      <Eg>
        <div className="flex items-center justify-between">
          <span>Flights (paid for both)</span>
          <span className="tabular-nums">−€240.00</span>
        </div>
        <div className="flex items-center justify-between text-zinc-500">
          <span>↳ Alex paid me back</span>
          <span className="tabular-nums">+€120.00</span>
        </div>
        <div className="mt-1 border-t border-zinc-200 pt-1 text-right text-xs dark:border-zinc-700">
          counts as €120.00 of Travel
        </div>
      </Eg>
    ),
    details: (
      <>
        <Point label="Why not just call it income?">
          Because it isn’t. If a €120 payback counted as income, your month
          would show more earnings and more spending than really happened. Linked
          instead, it reduces the original expense — which is what actually
          occurred.
        </Point>
        <Point label="Where you'll see the difference.">
          The repaid amount comes off that expense’s own category, so Travel
          shows €120 rather than €240, and your income figure stays untouched.
        </Point>
        <Point label="How to do it.">
          Open the incoming transaction and pick the expense it pays back. To
          undo, unlink it and both go back to standing alone.
        </Point>
      </>
    ),
  },
  {
    icon: "🛠️",
    title: "A few power tools",
    body: "Recurring rules post regular bills for you, category rules tidy up imports, exchange rates keep foreign accounts honest, and a Telegram bot logs cash spending in seconds.",
    details: (
      <>
        <Point label="Telegram, for cash.">
          Card spending arrives with your statement, but cash doesn’t. Link the
          bot from the Telegram card and you can message an amount, tap a
          category, add a note, and it’s in your ledger before you leave the
          shop.
        </Point>
        <Point label="Rules are yours to edit.">
          Everything the app learned from your corrections is listed under Rules
          — you can change or delete any of them if a merchant should be
          categorized differently.
        </Point>
      </>
    ),
  },
  {
    icon: "🚀",
    title: "Ready when you are",
    body: "Start by adding your first account, then import a statement or add a few transactions. The checklist on your dashboard tracks what's left, and you can reopen this guide anytime from the “Guide” button up top.",
    cta: { href: "/accounts", label: "Add my first account" },
  },
];

/**
 * First-run walkthrough. The parent renders it only while open, so each opening
 * starts fresh at step 1; on finish/skip it calls onClose (which records the
 * localStorage flag).
 */
export function WelcomeTour({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState(0);
  const s = STEPS[step];
  const last = step === STEPS.length - 1;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="my-8 w-full max-w-lg rounded-xl border border-zinc-200 bg-white p-6 shadow-xl dark:border-zinc-800 dark:bg-zinc-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <span className="text-xs text-zinc-400">
            Step {step + 1} of {STEPS.length}
          </span>
          <button
            onClick={onClose}
            className="text-xs text-zinc-400 hover:text-zinc-600 hover:underline dark:hover:text-zinc-300"
          >
            Skip
          </button>
        </div>

        <div className="text-4xl">{s.icon}</div>
        <h2 className="mt-2 text-lg font-semibold">{s.title}</h2>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-300">{s.body}</p>
        {s.example}
        {s.details && <More>{s.details}</More>}
        {s.cta && (
          <Link
            href={s.cta.href}
            onClick={onClose}
            className="mt-3 inline-block rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
          >
            {s.cta.label}
          </Link>
        )}

        <div className="mt-6 flex items-center justify-between">
          <div className="flex gap-1.5">
            {STEPS.map((_, i) => (
              <span
                key={i}
                aria-hidden
                className={`h-1.5 rounded-full transition-all ${
                  i === step
                    ? "w-4 bg-zinc-800 dark:bg-zinc-200"
                    : "w-1.5 bg-zinc-300 dark:bg-zinc-700"
                }`}
              />
            ))}
          </div>
          <div className="flex gap-2">
            {step > 0 && (
              <Button variant="ghost" onClick={() => setStep((v) => v - 1)}>
                Back
              </Button>
            )}
            {last ? (
              <Button onClick={onClose}>Done</Button>
            ) : (
              <Button onClick={() => setStep((v) => v + 1)}>Next</Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
