"use client";

import { useEffect, useState, type Dispatch, type SetStateAction } from "react";

/**
 * State that survives leaving the page and coming back, so filters and the
 * selected month do not reset every time you check another tab of the app.
 *
 * Backed by sessionStorage rather than localStorage on purpose: a filter that
 * outlives the browser session is a trap, because the next visit would silently
 * show a subset of the data with no memory of why.
 *
 * `revive` validates whatever was stored — it may be stale or hand-edited — and
 * returns null to fall back to the default.
 */
export function useStickyState<T>(
  key: string,
  fallback: T,
  revive: (saved: unknown) => T | null,
): [T, Dispatch<SetStateAction<T>>] {
  // Lazy initializer (not an effect): reads once, and never during SSR where
  // sessionStorage does not exist.
  const [value, setValue] = useState<T>(() => {
    if (typeof window === "undefined") return fallback;
    try {
      const raw = sessionStorage.getItem(key);
      if (!raw) return fallback;
      return revive(JSON.parse(raw)) ?? fallback;
    } catch {
      return fallback;
    }
  });

  useEffect(() => {
    try {
      sessionStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Storage can be full or blocked (private mode); persistence is a
      // convenience, so failing to save must never break the page.
    }
  }, [key, value]);

  return [value, setValue];
}

/** Shared reviver for the "YYYY-MM" period pickers; null means current month. */
export function revivePeriod(saved: unknown): string | null {
  if (saved === null) return null;
  return typeof saved === "string" && /^\d{4}-\d{2}$/.test(saved) ? saved : null;
}
