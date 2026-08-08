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

const STEPS: Step[] = [
  {
    icon: "👋",
    title: "Welcome to your finance tracker",
    body: "It's private and runs on your own machine — your data never leaves it. Here's a 60-second tour of what each section does.",
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
  },
  {
    icon: "📊",
    title: "Overview",
    body: "Your dashboard: income vs spending for the month, a donut of where money goes, how you're trending vs your 3-month average, net worth over time, and what's due soon.",
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
  },
  {
    icon: "🔗",
    title: "A few power tools",
    body: "Link a refund to the expense it pays back so it nets out. Set recurring rules that post bills automatically, manage your categories, and add exchange rates for foreign accounts.",
  },
  {
    icon: "🚀",
    title: "Ready when you are",
    body: "Start by adding your first account, then import a statement or add a few transactions. You can reopen this guide anytime from the “Guide” button up top.",
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
