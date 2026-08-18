"use client";

import { useState, type FormEvent } from "react";
import { Button, Input } from "@/components/ui";

/**
 * Confirmation for the handful of actions that wipe data outright. A browser
 * confirm() is one careless Enter away from disaster, so these ask the user to
 * type a word: the point is not ceremony, it is forcing a moment of reading.
 *
 * Rendered only while open, so the typed text starts empty every time.
 */
export function ConfirmPhrase({
  title,
  body,
  phrase = "DELETE",
  confirmLabel,
  busy,
  onConfirm,
  onCancel,
}: {
  title: string;
  body: string;
  /** The word the user has to type; shown to them verbatim. */
  phrase?: string;
  confirmLabel: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [typed, setTyped] = useState("");
  const armed = typed.trim().toUpperCase() === phrase.toUpperCase();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (armed && !busy) onConfirm();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onCancel}
    >
      <form
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-xl border border-zinc-200 bg-white p-5 shadow-xl dark:border-zinc-800 dark:bg-zinc-900"
      >
        <h2 className="text-lg font-semibold text-red-600 dark:text-red-400">
          {title}
        </h2>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-300">{body}</p>
        <label className="mt-4 block text-sm">
          <span className="text-zinc-600 dark:text-zinc-300">
            Type <b>{phrase}</b> to confirm
          </span>
          <Input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            className="mt-1 w-full"
            autoFocus
            autoComplete="off"
            aria-label={`Type ${phrase} to confirm`}
          />
        </label>
        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <button
            type="submit"
            disabled={!armed || busy}
            className="rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? "Deleting…" : confirmLabel}
          </button>
        </div>
      </form>
    </div>
  );
}
