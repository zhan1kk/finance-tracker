"use client";

import { useQuery } from "@tanstack/react-query";
import { Card } from "@/components/ui";
import { api } from "@/lib/api";
import type { AccuracyStats, AccuracyTally } from "@/lib/types";

const pct = (t: AccuracyTally): string =>
  t.accuracy === null ? "—" : `${Math.round(t.accuracy * 100)}%`;

export function AccuracyCard() {
  const stats = useQuery({
    queryKey: ["import-accuracy"],
    queryFn: () => api<AccuracyStats>("/imports/stats/accuracy"),
  });

  const data = stats.data;
  if (!data || data.overall.predicted === 0) {
    return (
      <Card>
        <h2 className="mb-1 font-medium">Categorization accuracy</h2>
        <p className="text-sm text-zinc-500">
          Once you import and confirm some transactions, this shows how often the
          automatic category was right — and whether it improves as it learns.
        </p>
      </Card>
    );
  }

  const { overall, bySource, byBatch } = data;
  const corrected = overall.predicted - overall.correct;

  return (
    <Card>
      <h2 className="mb-3 font-medium">Categorization accuracy</h2>

      <div className="mb-4 flex flex-wrap items-end gap-x-8 gap-y-3">
        <div>
          <p className="text-sm text-zinc-500">Predictions kept</p>
          <p className="text-4xl font-semibold">{pct(overall)}</p>
          <p className="text-xs text-zinc-400">
            {overall.correct} of {overall.predicted} kept · {corrected} corrected
          </p>
        </div>
        <Tile label="From rules" tally={bySource.RULE} />
        <Tile label="From the AI" tally={bySource.LLM} />
      </div>

      {byBatch.length > 1 && (
        <div>
          <p className="mb-2 text-xs font-medium tracking-wide text-zinc-500 uppercase">
            Per import, over time
          </p>
          <RecentBatches rows={byBatch} />
        </div>
      )}
    </Card>
  );
}

/** Statements accumulate one row a month and are never cleaned up, so show the
 *  recent ones and fold the rest — the same shape as the import history and FX
 *  rate lists sitting beside this card. */
const RECENT_BATCHES = 8;

function RecentBatches({ rows }: { rows: AccuracyStats["byBatch"] }) {
  const recent = rows.slice(0, RECENT_BATCHES);
  const older = rows.slice(RECENT_BATCHES);
  const list = (items: AccuracyStats["byBatch"]) => (
    <ul className="flex flex-col gap-1.5">
      {items.map((batch) => (
              <li key={batch.batchId} className="flex items-center gap-3">
                <span
                  className="w-32 shrink-0 truncate text-sm"
                  title={batch.filename}
                >
                  {batch.filename}
                </span>
                <span aria-hidden className="relative h-4 flex-1">
                  <span
                    className="absolute inset-y-0 left-0 rounded-r-[4px]"
                    style={{
                      width: `${Math.round((batch.accuracy ?? 0) * 100)}%`,
                      backgroundColor: "var(--chart-series-1)",
                    }}
                  />
                </span>
                <span className="w-10 shrink-0 text-right text-sm tabular-nums">
                  {pct(batch)}
                </span>
                <span className="w-16 shrink-0 text-right text-xs tabular-nums text-zinc-400">
                  {batch.correct}/{batch.predicted}
                </span>
        </li>
      ))}
    </ul>
  );

  return (
    <>
      {list(recent)}
      {older.length > 0 && (
        <details className="mt-2">
          <summary className="cursor-pointer text-xs text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300">
            {older.length} older import{older.length === 1 ? "" : "s"}
          </summary>
          <div className="mt-1.5">{list(older)}</div>
        </details>
      )}
    </>
  );
}

function Tile({ label, tally }: { label: string; tally: AccuracyTally }) {
  return (
    <div>
      <p className="text-sm text-zinc-500">{label}</p>
      <p className="text-2xl font-semibold">{pct(tally)}</p>
      <p className="text-xs text-zinc-400">
        {tally.predicted === 0 ? "no predictions" : `${tally.predicted} predicted`}
      </p>
    </div>
  );
}
