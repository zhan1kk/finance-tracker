"use client";

import { useState, type FormEvent } from "react";
import { Button, Field, Input } from "@/components/ui";

/**
 * A themed stand-in for window.prompt().
 *
 * The native prompt ignores dark mode, has nowhere to put help text, cannot
 * validate until after it closes, and renders differently — and cramped — on
 * every mobile browser. This matches the app's own form primitives and blocks
 * submission while the value is invalid, so a bad amount is caught in place
 * rather than surfacing as an error further down the page.
 *
 * Rendered only while open, so it always starts from the value passed in.
 */
export function PromptDialog({
  title,
  label,
  help,
  initialValue,
  confirmLabel = "Save",
  inputMode,
  busy,
  validate,
  onSubmit,
  onCancel,
}: {
  title: string;
  label: string;
  help?: string;
  initialValue: string;
  confirmLabel?: string;
  inputMode?: "text" | "decimal";
  busy?: boolean;
  /** An error to show, or null when the value is acceptable. */
  validate?: (raw: string) => string | null;
  onSubmit: (raw: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initialValue);
  // The starting value comes from saved data, so this is null on open and only
  // appears once the user makes it invalid.
  const error = validate?.(value) ?? null;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!error && !busy) onSubmit(value);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onCancel}
    >
      <form
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") onCancel();
        }}
        className="w-full max-w-md rounded-xl border border-zinc-200 bg-white p-5 shadow-xl dark:border-zinc-800 dark:bg-zinc-900"
      >
        <h2 className="text-lg font-semibold">{title}</h2>
        {help && (
          <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-300">{help}</p>
        )}
        <div className="mt-4">
          <Field label={label}>
            <Input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              className="w-full"
              inputMode={inputMode}
              autoFocus
              autoComplete="off"
            />
          </Field>
          {error && <p className="mt-1 text-sm text-red-600">{error}</p>}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" disabled={!!error || busy}>
            {busy ? "Saving…" : confirmLabel}
          </Button>
        </div>
      </form>
    </div>
  );
}
