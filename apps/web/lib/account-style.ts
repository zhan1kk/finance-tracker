import type { AccountType } from "@/lib/types";

// One colour per account type, so kinds are distinguishable at a glance across
// the app: a tinted type badge plus a matching left stripe on the card.
export const TYPE_BADGE: Record<AccountType, string> = {
  checking: "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300",
  savings: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  cash: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  credit: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300",
  investment:
    "bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300",
  crypto:
    "bg-orange-100 text-orange-700 dark:bg-orange-950 dark:text-orange-300",
};

export const TYPE_ACCENT: Record<AccountType, string> = {
  checking: "border-l-sky-400",
  savings: "border-l-amber-400",
  cash: "border-l-emerald-400",
  credit: "border-l-red-400",
  investment: "border-l-violet-400",
  crypto: "border-l-orange-400",
};
