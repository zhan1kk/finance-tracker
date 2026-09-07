"use client";

import { useEffect, useMemo, useRef, useState } from "react";

export type MultiSelectOption = {
  id: string;
  label: string;
  /** Optional group heading; options sharing a group are listed together. */
  group?: string;
};

/**
 * A searchable, grouped multi-select dropdown. Built for long option lists (e.g.
 * many categories): a type-to-filter box narrows the list, groups keep it
 * scannable, and it closes on outside-click / Escape. Purely controlled — the
 * caller owns `selected`.
 */
export function MultiSelect({
  options,
  selected,
  onChange,
  placeholder = "All",
  searchPlaceholder = "Search…",
  triggerClassName = "w-40",
  panelClassName = "w-64",
}: {
  options: MultiSelectOption[];
  selected: string[];
  onChange: (ids: string[]) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  triggerClassName?: string;
  panelClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  // Close on click outside or Escape (listeners only — query is reset on open,
  // in the trigger handler, to avoid setting state from within an effect).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const toggle = (id: string) =>
    onChange(
      selectedSet.has(id) ? selected.filter((x) => x !== id) : [...selected, id],
    );

  const q = query.trim().toLowerCase();
  const filtered = q
    ? options.filter((o) => o.label.toLowerCase().includes(q))
    : options;

  // Group filtered options, preserving the order they arrive in.
  const groups = useMemo(() => {
    const m = new Map<string, MultiSelectOption[]>();
    for (const o of filtered) {
      const key = o.group ?? "";
      const list = m.get(key) ?? [];
      list.push(o);
      m.set(key, list);
    }
    return m;
  }, [filtered]);

  const filteredIds = filtered.map((o) => o.id);
  const allFilteredSelected =
    filteredIds.length > 0 && filteredIds.every((id) => selectedSet.has(id));
  const toggleAllFiltered = () => {
    if (allFilteredSelected) {
      const drop = new Set(filteredIds);
      onChange(selected.filter((id) => !drop.has(id)));
    } else {
      onChange([...new Set([...selected, ...filteredIds])]);
    }
  };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => {
          const next = !open;
          setOpen(next);
          if (next) setQuery(""); // fresh search each time it opens
        }}
        className={`flex h-9 ${triggerClassName} cursor-pointer items-center justify-between rounded-md border border-zinc-300 bg-white px-2 text-sm dark:border-zinc-700 dark:bg-zinc-900`}
      >
        <span className={selected.length ? "" : "text-zinc-500"}>
          {selected.length === 0 ? placeholder : `${selected.length} selected`}
        </span>
        <span className="text-zinc-400">▾</span>
      </button>
      {open && (
        <div
          className={`absolute z-20 mt-1 ${panelClassName} rounded-md border border-zinc-200 bg-white shadow-lg dark:border-zinc-800 dark:bg-zinc-900`}
        >
          <div className="border-b border-zinc-100 p-2 dark:border-zinc-800">
            <input
              autoFocus
              aria-label={searchPlaceholder}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={searchPlaceholder}
              className="w-full rounded border border-zinc-300 bg-white px-2 py-1 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900"
            />
          </div>
          <div className="flex items-center justify-between px-2 py-1 text-xs text-zinc-400">
            <span>{selected.length} selected</span>
            <div className="flex gap-2">
              {filtered.length > 0 && (
                <button
                  type="button"
                  className="hover:underline"
                  onClick={toggleAllFiltered}
                >
                  {allFilteredSelected ? "Unselect all" : "Select all"}
                </button>
              )}
              {selected.length > 0 && (
                <button
                  type="button"
                  className="hover:underline"
                  onClick={() => onChange([])}
                >
                  Clear
                </button>
              )}
            </div>
          </div>
          <div className="max-h-64 overflow-y-auto p-1">
            {[...groups.entries()].map(([group, opts]) => (
              <div key={group} className="mb-1">
                {group && (
                  <p className="px-1 pt-1 text-xs font-medium text-zinc-400">
                    {group}
                  </p>
                )}
                {opts.map((o) => (
                  <label
                    key={o.id}
                    className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800"
                  >
                    <input
                      type="checkbox"
                      checked={selectedSet.has(o.id)}
                      onChange={() => toggle(o.id)}
                    />
                    {o.label}
                  </label>
                ))}
              </div>
            ))}
            {filtered.length === 0 && (
              <p className="px-1 py-1 text-xs text-zinc-400">No matches.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
