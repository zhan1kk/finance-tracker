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

  return (
    <div className="mx-auto max-w-5xl p-4">
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
