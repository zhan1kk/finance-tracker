"use client";

import { useEffect, useState } from "react";

type Theme = "light" | "dark" | "system";
const KEY = "ft:theme";

/** Resolve a choice to a concrete mode and stamp it on <html data-theme>. */
function apply(theme: Theme) {
  const dark =
    theme === "dark" ||
    (theme === "system" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
}

/**
 * Cycles System → Light → Dark. The initial DOM theme is set before paint by a
 * script in the root layout, so this only needs to keep it in sync afterwards
 * (and follow the OS while on "system"). Reads the saved choice in a lazy
 * initializer; `suppressHydrationWarning` covers the icon differing from the
 * server's default until hydration.
 */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(() =>
    typeof window === "undefined"
      ? "system"
      : ((localStorage.getItem(KEY) as Theme | null) ?? "system"),
  );

  useEffect(() => {
    apply(theme);
    if (theme !== "system") return;
    // Track OS changes live while following the system preference.
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => apply("system");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme]);

  const nextOf: Record<Theme, Theme> = {
    system: "light",
    light: "dark",
    dark: "system",
  };
  const icon: Record<Theme, string> = {
    system: "🖥️",
    light: "☀️",
    dark: "🌙",
  };
  const name: Record<Theme, string> = {
    system: "System",
    light: "Light",
    dark: "Dark",
  };

  const choose = (t: Theme) => {
    localStorage.setItem(KEY, t);
    setTheme(t);
  };

  return (
    <button
      suppressHydrationWarning
      onClick={() => choose(nextOf[theme])}
      title={`Theme: ${name[theme]} — switch to ${name[nextOf[theme]]}`}
      aria-label={`Theme: ${name[theme]}`}
      className="rounded-md border border-zinc-300 px-2 py-1.5 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
    >
      <span suppressHydrationWarning>{icon[theme]}</span>
    </button>
  );
}
