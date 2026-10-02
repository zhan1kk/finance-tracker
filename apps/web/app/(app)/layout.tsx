"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui";
import { WELCOME_SEEN_KEY, WelcomeTour } from "@/components/welcome-tour";
import { useAuth } from "@/lib/auth";

const NAV = [
  { href: "/", label: "Overview" },
  { href: "/transactions", label: "Transactions" },
  { href: "/budgets", label: "Budgets" },
  { href: "/reminders", label: "Reminders" },
  { href: "/split", label: "Split" },
  { href: "/recurring", label: "Recurring" },
  { href: "/imports", label: "Import" },
  { href: "/rules", label: "Rules" },
  { href: "/accounts", label: "Accounts" },
  { href: "/subcategories", label: "Categories" },
];

export default function AppLayout({ children }: { children: ReactNode }) {
  const { user, loading, logout } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  // Auto-open the walkthrough on the first visit (no localStorage flag yet). A
  // lazy initializer keeps it out of an effect; the tour only renders once the
  // authenticated shell does, so there's no hydration mismatch.
  const [tourOpen, setTourOpen] = useState(
    () =>
      typeof window !== "undefined" &&
      !localStorage.getItem(WELCOME_SEEN_KEY),
  );

  useEffect(() => {
    if (!loading && !user) {
      router.replace("/login");
    }
  }, [loading, user, router]);

  const closeTour = () => {
    setTourOpen(false);
    localStorage.setItem(WELCOME_SEEN_KEY, "1");
  };

  if (loading || !user) {
    return (
      <main className="flex min-h-screen items-center justify-center text-zinc-500">
        Loading…
      </main>
    );
  }

  // 80rem for every page, not only the wide tables. Widening transactions on
  // its own made the shell change width on every navigation, which reads as the
  // layout breaking rather than as one page taking the room it needs — a
  // consistent frame is worth more than per-page fit.
  return (
    <div className="mx-auto max-w-7xl p-4">
      <header className="mb-6 flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <span className="text-lg font-semibold">Finance Tracker</span>
          <div className="ml-auto flex items-center gap-2 text-sm text-zinc-500">
            {/* The email doubles as the way into account settings — keeps it
                out of the data nav, where people look for pages, not prefs. */}
            <Link
              href="/settings"
              className="hidden truncate hover:text-zinc-700 hover:underline sm:inline dark:hover:text-zinc-300"
              title="Account settings"
            >
              {user.email}
            </Link>
            <Button
              variant="ghost"
              onClick={() => setTourOpen(true)}
              title="Replay the welcome guide"
            >
              Guide
            </Button>
            {/* The email above is the same link, but it is hidden below the
                sm breakpoint — so on a phone there was no way into settings at
                all, and an email address does not read as "settings" anyway. */}
            <Link
              href="/settings"
              aria-label="Settings"
              title="Settings"
              className="inline-flex items-center rounded-md border border-zinc-300 px-2.5 py-1.5 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
            >
              <svg
                aria-hidden
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.8}
                strokeLinecap="round"
                strokeLinejoin="round"
                className="h-4 w-4"
              >
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
            </Link>
            <ThemeToggle />
            <Button
              variant="ghost"
              onClick={() => void logout().then(() => router.replace("/login"))}
            >
              Sign out
            </Button>
          </div>
        </div>
        {/* One scrollable row on every width — avoids a 4-row wrap on phones. */}
        <nav className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={`shrink-0 rounded-md px-3 py-1.5 text-sm whitespace-nowrap ${
                pathname === item.href
                  ? "bg-zinc-200 font-medium dark:bg-zinc-800"
                  : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-900"
              }`}
            >
              {item.label}
            </Link>
          ))}
        </nav>
      </header>
      {children}
      {tourOpen && <WelcomeTour onClose={closeTour} />}
    </div>
  );
}
