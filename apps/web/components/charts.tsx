"use client";

import { useState } from "react";
import { formatCents, formatCentsCompact } from "@/lib/format";
import type { CategoryStat, MonthlyStat } from "@/lib/types";

const SERIES_1 = "var(--chart-series-1)";
const SERIES_2 = "var(--chart-series-2)";

/* Grouped-columns geometry, in viewBox units. The x-axis label band is part
   of the viewBox so a fixed container height can never crop it. */
const W = 520;
const PAD_TOP = 14;
const PAD_RIGHT = 8;
const GUTTER = 48;
const AXIS_BAND = 22;
const PLOT_H = 160;
const H = PAD_TOP + PLOT_H + AXIS_BAND;
const PLOT_W = W - GUTTER - PAD_RIGHT;
const TICK_COUNT = 3;

/** Smallest "clean" number (1/2/2.5/5 × 10^n) at or above v. */
function niceCeil(v: number): number {
  const pow = 10 ** Math.floor(Math.log10(v));
  const unit = v / pow;
  const nice = [1, 2, 2.5, 5, 10].find((c) => unit <= c) ?? 10;
  return nice * pow;
}

/** Column with a 4px-rounded cap and a square baseline. */
function columnPath(x: number, yTop: number, w: number, h: number): string {
  const r = Math.min(4, h, w / 2);
  const yBase = yTop + h;
  return [
    `M ${x} ${yBase}`,
    `L ${x} ${yTop + r}`,
    `Q ${x} ${yTop} ${x + r} ${yTop}`,
    `L ${x + w - r} ${yTop}`,
    `Q ${x + w} ${yTop} ${x + w} ${yTop + r}`,
    `L ${x + w} ${yBase}`,
    "Z",
  ].join(" ");
}

function monthLabel(month: string): string {
  const [year, m] = month.split("-").map(Number);
  return new Date(year, m - 1, 1).toLocaleDateString(undefined, {
    month: "short",
  });
}

function TableToggle({
  asTable,
  onToggle,
}: {
  asTable: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={asTable}
      onClick={onToggle}
      className="ml-auto text-xs text-zinc-500 underline decoration-zinc-300 underline-offset-2 hover:text-zinc-700 dark:decoration-zinc-700 dark:hover:text-zinc-300"
    >
      {asTable ? "View as chart" : "View as table"}
    </button>
  );
}

export function MonthlyTrendChart({
  data,
  currency,
}: {
  /** One point per month, oldest first; gaps already filled with zeros. */
  data: MonthlyStat[];
  currency: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const [asTable, setAsTable] = useState(false);

  const rawMax = Math.max(...data.map((d) => Math.max(d.income, d.expense)));
  if (rawMax <= 0) {
    return (
      <p className="py-8 text-center text-sm text-zinc-500">
        No income or spending in this period yet.
      </p>
    );
  }

  const step = niceCeil(rawMax / TICK_COUNT);
  const yMax = step * TICK_COUNT;
  const y = (cents: number) => PAD_TOP + PLOT_H * (1 - cents / yMax);

  const band = PLOT_W / data.length;
  const colWidth = Math.min(24, (band - 24) / 2);

  const legend = (
    <div className="mb-2 flex items-center gap-4 text-xs text-zinc-500">
      {[
        ["Income", SERIES_1],
        ["Spending", SERIES_2],
      ].map(([label, color]) => (
        <span key={label} className="flex items-center gap-1.5">
          <span
            aria-hidden
            className="h-2 w-2 rounded-full"
            style={{ backgroundColor: color }}
          />
          {label}
        </span>
      ))}
      <TableToggle asTable={asTable} onToggle={() => setAsTable(!asTable)} />
    </div>
  );

  if (asTable) {
    return (
      <div>
        {legend}
        <div className="overflow-x-auto">
        <table className="w-full min-w-[20rem] text-sm">
          <thead>
            <tr className="border-b border-zinc-200 text-left text-zinc-500 dark:border-zinc-800">
              <th className="py-1.5 font-medium">Month</th>
              <th className="py-1.5 text-right font-medium">Income</th>
              <th className="py-1.5 text-right font-medium">Spending</th>
            </tr>
          </thead>
          <tbody>
            {data.map((d) => (
              <tr
                key={d.month}
                className="border-b border-zinc-100 dark:border-zinc-900"
              >
                <td className="py-1.5">{monthLabel(d.month)}</td>
                <td className="py-1.5 text-right tabular-nums">
                  {formatCents(d.income, currency)}
                </td>
                <td className="py-1.5 text-right tabular-nums">
                  {formatCents(d.expense, currency)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </div>
    );
  }

  const hovered = hover !== null ? data[hover] : null;

  return (
    <div>
      {legend}
      <div className="relative">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="w-full"
          role="img"
          aria-label="Monthly income and spending columns; table view available"
        >
          {/* gridlines + ticks */}
          {Array.from({ length: TICK_COUNT + 1 }, (_, i) => {
            const value = step * i;
            const gy = y(value);
            return (
              <g key={i}>
                <line
                  x1={GUTTER}
                  x2={W - PAD_RIGHT}
                  y1={gy}
                  y2={gy}
                  stroke={i === 0 ? "var(--chart-axis)" : "var(--chart-grid)"}
                  strokeWidth={1}
                />
                {i > 0 && (
                  <text
                    x={GUTTER - 6}
                    y={gy + 3}
                    textAnchor="end"
                    fontSize={10}
                    fill="var(--chart-muted)"
                    style={{ fontVariantNumeric: "tabular-nums" }}
                  >
                    {formatCentsCompact(value, currency)}
                  </text>
                )}
              </g>
            );
          })}

          {data.map((d, i) => {
            const x0 = GUTTER + band * i;
            const cx = x0 + band / 2;
            const values: [number, string][] = [
              [d.income, SERIES_1],
              [d.expense, SERIES_2],
            ];
            return (
              <g key={d.month}>
                {values.map(([value, color], s) => {
                  if (value <= 0) return null;
                  const h = (value / yMax) * PLOT_H;
                  // 2px surface gap between the pair
                  const x = cx + (s === 0 ? -colWidth - 1 : 1);
                  return (
                    <path
                      key={s}
                      d={columnPath(x, y(value), colWidth, h)}
                      fill={color}
                      opacity={hover === null || hover === i ? 1 : 0.45}
                    />
                  );
                })}
                <text
                  x={cx}
                  y={PAD_TOP + PLOT_H + 15}
                  textAnchor="middle"
                  fontSize={10}
                  fill="var(--chart-muted)"
                >
                  {monthLabel(d.month)}
                </text>
                {/* full-band hover/focus target */}
                <rect
                  x={x0}
                  y={PAD_TOP}
                  width={band}
                  height={PLOT_H}
                  fill="transparent"
                  tabIndex={0}
                  aria-label={`${d.month}: income ${formatCents(d.income, currency)}, spending ${formatCents(d.expense, currency)}`}
                  onMouseEnter={() => setHover(i)}
                  onMouseLeave={() => setHover(null)}
                  onFocus={() => setHover(i)}
                  onBlur={() => setHover(null)}
                />
              </g>
            );
          })}
        </svg>

        {hovered && hover !== null && (
          <div
            className="pointer-events-none absolute top-0 z-10 -translate-x-1/2 rounded-md bg-zinc-900 px-2.5 py-1.5 text-xs text-white shadow dark:bg-zinc-700"
            style={{
              left: `${(((GUTTER + band * (hover + 0.5)) / W) * 100).toFixed(2)}%`,
            }}
          >
            <p className="mb-0.5 font-medium">{hovered.month}</p>
            <p>Income {formatCents(hovered.income, currency)}</p>
            <p>Spending {formatCents(hovered.expense, currency)}</p>
          </div>
        )}
      </div>
    </div>
  );
}

const MAX_CATEGORY_ROWS = 7;

export function CategoryBars({
  data,
  currency,
}: {
  /** Sorted by amount descending (as the stats endpoint returns them). */
  data: CategoryStat[];
  currency: string;
}) {
  const [hover, setHover] = useState<number | null>(null);

  const spending = data.filter((d) => d.amount > 0);
  if (spending.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-zinc-500">
        No spending in this period yet.
      </p>
    );
  }

  const rows: { label: string; amount: number }[] = spending
    .slice(0, MAX_CATEGORY_ROWS)
    .map((d) => ({ label: d.name, amount: d.amount }));
  const tail = spending.slice(MAX_CATEGORY_ROWS);
  if (tail.length > 0) {
    rows.push({
      label: "Other",
      amount: tail.reduce((sum, d) => sum + d.amount, 0),
    });
  }

  const total = spending.reduce((sum, d) => sum + d.amount, 0);
  const max = Math.max(...rows.map((r) => r.amount));

  return (
    <ul className="flex flex-col gap-2">
      {rows.map((row, i) => {
        const share = Math.round((row.amount / total) * 100);
        return (
          <li
            key={row.label}
            tabIndex={0}
            aria-label={`${row.label}: ${formatCents(row.amount, currency)}, ${share}% of spending`}
            className="flex items-center gap-3 rounded outline-offset-2"
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover(null)}
            onFocus={() => setHover(i)}
            onBlur={() => setHover(null)}
          >
            <span className="w-28 shrink-0 truncate text-sm" title={row.label}>
              {row.label}
            </span>
            <span aria-hidden className="relative h-4 flex-1">
              <span
                className="absolute inset-y-0 left-0 rounded-r-[4px]"
                style={{
                  width: `${((row.amount / max) * 100).toFixed(1)}%`,
                  backgroundColor: SERIES_1,
                  opacity: hover === null || hover === i ? 1 : 0.45,
                }}
              />
            </span>
            <span className="w-20 shrink-0 text-right text-sm tabular-nums">
              {formatCents(row.amount, currency)}
            </span>
            <span
              aria-hidden
              className="w-9 shrink-0 text-xs tabular-nums text-zinc-400"
            >
              {hover === i ? `${share}%` : ""}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

// Colour-vision-deficiency-safe categorical palette (Okabe-Ito), used in a fixed
// order so a category keeps its colour. "Other" always takes the grey.
const DONUT_COLORS = [
  "#0072B2", // blue
  "#E69F00", // orange
  "#009E73", // green
  "#CC79A7", // purple
  "#56B4E9", // sky
  "#D55E00", // vermillion
  "#F0E442", // yellow
];
const DONUT_OTHER = "#9AA0A6";

function polar(cx: number, cy: number, radius: number, angle: number): [number, number] {
  return [cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)];
}

/** Donut-slice path between two angles (radians), outer radius R, inner r. */
function arcPath(cx: number, cy: number, R: number, r: number, a0: number, a1: number): string {
  const large = a1 - a0 > Math.PI ? 1 : 0;
  const [x1, y1] = polar(cx, cy, R, a0);
  const [x2, y2] = polar(cx, cy, R, a1);
  const [x3, y3] = polar(cx, cy, r, a1);
  const [x4, y4] = polar(cx, cy, r, a0);
  return `M ${x1} ${y1} A ${R} ${R} 0 ${large} 1 ${x2} ${y2} L ${x3} ${y3} A ${r} ${r} 0 ${large} 0 ${x4} ${y4} Z`;
}

// Spend types the donut can filter to, in a stable display order.
const SPENDING_CATEGORY_ORDER = [
  "Expenses",
  "Bills",
  "Subscriptions",
  "Debts",
  "Savings",
];

/**
 * Expense composition as a donut: one slice per subcategory (top 7, the rest
 * grouped into "Other"), with a legend carrying the amounts and shares. Chips
 * scope it to a single spend type (Bills, Subscriptions, …) so you can see the
 * split *within* one; "View as table" — or clicking the Other slice — expands
 * every subcategory, so nothing stays hidden inside Other. A 2px surface ring
 * separates slices; the table view also backs it for accessibility.
 */
export function CategoryDonut({
  data,
  currency,
}: {
  data: CategoryStat[];
  currency: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const [asTable, setAsTable] = useState(false);
  const [filter, setFilter] = useState<string>("All");
  // Categories hidden from this chart, by subcategory id. One big line item
  // (rent, say) flattens everything else against the same scale, so hiding it
  // is the difference between a readable chart and four invisible slivers.
  // Deliberately view-only: local state, nothing saved, nothing else reads it,
  // and the strip below always names what is hidden so no total is misread.
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const toggleExcluded = (id: string) =>
    setExcluded((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  // Spend types actually present this period, in a stable order.
  const present = SPENDING_CATEGORY_ORDER.filter((c) =>
    data.some((d) => d.category === c && d.amount > 0),
  );
  const active = filter !== "All" && present.includes(filter) ? filter : "All";
  const scoped =
    active === "All" ? data : data.filter((d) => d.category === active);
  const visible = scoped.filter((d) => d.amount > 0);
  const hidden = visible.filter((d) => excluded.has(d.subcategoryId));
  const spending = visible
    .filter((d) => !excluded.has(d.subcategoryId))
    .sort((a, b) => b.amount - a.amount);

  const chip = (on: boolean) =>
    `rounded-full px-2.5 py-1 text-xs ${
      on
        ? "bg-zinc-800 text-white dark:bg-zinc-200 dark:text-zinc-900"
        : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700"
    }`;

  const controls = (
    <div className="mb-2 flex flex-wrap items-center gap-1.5">
      {present.length > 1 &&
        ["All", ...present].map((c) => (
          <button
            key={c}
            onClick={() => setFilter(c)}
            className={chip(active === c)}
          >
            {c === "All" ? "All spending" : c}
          </button>
        ))}
      <TableToggle asTable={asTable} onToggle={() => setAsTable(!asTable)} />
    </div>
  );

  // Never let an exclusion be invisible: the totals and percentages below are
  // computed without these, so they have to be spelled out next to them.
  const hiddenStrip = hidden.length > 0 && (
    <div className="mb-2 flex flex-wrap items-center gap-1.5 text-xs text-zinc-500">
      <span>Hidden:</span>
      {hidden.map((d) => (
        <button
          key={d.subcategoryId}
          onClick={() => toggleExcluded(d.subcategoryId)}
          title={`Show ${d.name} again`}
          className="rounded-full bg-zinc-100 px-2 py-0.5 line-through hover:no-underline dark:bg-zinc-800"
        >
          {d.name} ×
        </button>
      ))}
      <button
        onClick={() => setExcluded(new Set())}
        className="underline hover:text-zinc-700 dark:hover:text-zinc-300"
      >
        show all
      </button>
    </div>
  );

  if (spending.length === 0) {
    return (
      <div>
        {present.length > 0 && controls}
        {hiddenStrip}
        <p className="py-8 text-center text-sm text-zinc-500">
          No spending {active === "All" ? "in this period" : `in ${active}`} yet.
        </p>
      </div>
    );
  }

  const total = spending.reduce((s, d) => s + d.amount, 0);

  // The table view is the *full* breakdown — every subcategory, so whatever the
  // donut folded into "Other" is spelled out here.
  if (asTable) {
    return (
      <div>
        {controls}
        {hiddenStrip}
        <div className="overflow-x-auto">
        <table className="w-full min-w-[20rem] text-sm">
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-900">
            {spending.map((d) => (
              <tr key={d.subcategoryId}>
                <td className="py-1.5">
                  <button
                    className="hover:underline"
                    title={`Hide ${d.name} from this chart`}
                    onClick={() => toggleExcluded(d.subcategoryId)}
                  >
                    {d.name}
                  </button>
                </td>
                {active === "All" && (
                  <td className="py-1.5">
                    <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                      {d.category}
                    </span>
                  </td>
                )}
                <td className="py-1.5 text-right tabular-nums">
                  {formatCents(d.amount, currency)}
                </td>
                <td className="w-12 py-1.5 text-right tabular-nums text-zinc-400">
                  {Math.round((d.amount / total) * 100)}%
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </div>
    );
  }

  const slices: {
    label: string;
    amount: number;
    color: string;
    isOther: boolean;
    subcategoryId?: string;
  }[] = spending.slice(0, MAX_CATEGORY_ROWS).map((d, i) => ({
    label: d.name,
    amount: d.amount,
    color: DONUT_COLORS[i % DONUT_COLORS.length],
    isOther: false,
    subcategoryId: d.subcategoryId,
  }));
  const tail = spending.slice(MAX_CATEGORY_ROWS);
  if (tail.length > 0) {
    slices.push({
      label: "Other",
      amount: tail.reduce((s, d) => s + d.amount, 0),
      color: DONUT_OTHER,
      isOther: true,
    });
  }

  const size = 184;
  const cx = size / 2;
  const cy = size / 2;
  const R = 86;
  const r = 54;
  // Cumulative start angle per slice (12 o'clock origin), derived without a
  // render-scope mutable so each render is a pure function of `slices`.
  const START = -Math.PI / 2;
  const arcs = slices.map((s, i) => {
    const before = slices
      .slice(0, i)
      .reduce((sum, p) => sum + p.amount, 0);
    const a0 = START + (before / total) * Math.PI * 2;
    const a1 = a0 + (s.amount / total) * Math.PI * 2;
    return { ...s, i, path: arcPath(cx, cy, R, r, a0, a1) };
  });

  return (
    <div>
      {controls}
      {hiddenStrip}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <svg
          viewBox={`0 0 ${size} ${size}`}
          width={size}
          height={size}
          className="shrink-0"
          role="img"
          aria-label="Expense breakdown by category"
        >
          {arcs.map((a) => (
            <path
              key={a.label}
              d={a.path}
              fill={a.color}
              stroke="var(--chart-surface)"
              strokeWidth={2}
              style={{
                opacity: hover === null || hover === a.i ? 1 : 0.35,
                cursor: a.isOther ? "pointer" : "default",
              }}
              onMouseEnter={() => setHover(a.i)}
              onMouseLeave={() => setHover(null)}
              onClick={a.isOther ? () => setAsTable(true) : undefined}
            />
          ))}
          <text
            x={cx}
            y={cy - 5}
            textAnchor="middle"
            fontSize="9"
            fill="var(--chart-muted)"
          >
            total
          </text>
          <text
            x={cx}
            y={cy + 11}
            textAnchor="middle"
            fontSize="14"
            fontWeight="600"
            fill="currentColor"
          >
            {formatCentsCompact(total, currency)}
          </text>
        </svg>
        <ul className="flex min-w-44 flex-1 flex-col gap-1">
          {arcs.map((a) => {
            const share = Math.round((a.amount / total) * 100);
            const inner = (
              <>
                <span
                  aria-hidden
                  className="h-3 w-3 shrink-0 rounded-sm"
                  style={{ backgroundColor: a.color }}
                />
                <span className="truncate" title={a.label}>
                  {a.label}
                  {a.isOther ? ` (${tail.length})` : ""}
                </span>
                <span className="ml-auto tabular-nums text-zinc-500">
                  {formatCents(a.amount, currency)}
                </span>
                <span className="w-9 shrink-0 text-right text-xs tabular-nums text-zinc-400">
                  {share}%
                </span>
              </>
            );
            const dim = { opacity: hover === null || hover === a.i ? 1 : 0.5 };
            // "Other" is a button that opens the full table, so its contents
            // aren't hidden; the rest are plain legend rows.
            return a.isOther ? (
              <li key={a.label}>
                <button
                  className="flex w-full items-center gap-2 text-sm hover:text-zinc-700 dark:hover:text-zinc-200"
                  style={dim}
                  title="See everything grouped into Other"
                  onMouseEnter={() => setHover(a.i)}
                  onMouseLeave={() => setHover(null)}
                  onClick={() => setAsTable(true)}
                >
                  {inner}
                </button>
              </li>
            ) : (
              // Clicking a legend row hides that slice and rescales the rest —
              // the point of the feature, so it lives on the obvious target.
              <li key={a.label}>
                <button
                  className="flex w-full items-center gap-2 text-sm hover:text-zinc-700 dark:hover:text-zinc-200"
                  style={dim}
                  title={`Hide ${a.label} from this chart`}
                  onMouseEnter={() => setHover(a.i)}
                  onMouseLeave={() => setHover(null)}
                  onClick={() =>
                    a.subcategoryId && toggleExcluded(a.subcategoryId)
                  }
                >
                  {inner}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

/**
 * Net worth over time: one series → a 2px line with a 10% area wash, no legend
 * (the card title names it). The y-domain is always anchored to zero so the
 * magnitude is honest, and it extends below zero when net worth is negative.
 */
export function NetWorthChart({
  data,
  currency,
}: {
  /** One point per month, oldest first. */
  data: { month: string; netWorthCents: number }[];
  currency: string;
}) {
  const [hover, setHover] = useState<number | null>(null);

  if (data.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-zinc-500">No data yet.</p>
    );
  }

  const values = data.map((d) => d.netWorthCents);
  const rawMin = Math.min(0, ...values);
  const rawMax = Math.max(0, ...values);
  const step = niceCeil(Math.max((rawMax - rawMin) / TICK_COUNT, 100));
  let yMax = Math.ceil(rawMax / step) * step;
  const yMin = Math.floor(rawMin / step) * step;
  if (yMax === yMin) yMax = yMin + step;
  const y = (v: number) =>
    PAD_TOP + PLOT_H * (1 - (v - yMin) / (yMax - yMin));

  const ticks: number[] = [];
  for (let v = yMin; v <= yMax; v += step) ticks.push(v);

  const band = PLOT_W / data.length;
  const x = (i: number) => GUTTER + band * (i + 0.5);
  const linePath = data
    .map((d, i) => `${i === 0 ? "M" : "L"} ${x(i)} ${y(d.netWorthCents)}`)
    .join(" ");
  const areaPath = `${linePath} L ${x(data.length - 1)} ${y(0)} L ${x(0)} ${y(0)} Z`;

  const hovered = hover !== null ? data[hover] : null;
  const last = data[data.length - 1];

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        role="img"
        aria-label="Net worth by month"
      >
        {ticks.map((value) => (
          <g key={value}>
            <line
              x1={GUTTER}
              x2={W - PAD_RIGHT}
              y1={y(value)}
              y2={y(value)}
              stroke={value === 0 ? "var(--chart-axis)" : "var(--chart-grid)"}
              strokeWidth={1}
            />
            {value !== 0 && (
              <text
                x={GUTTER - 6}
                y={y(value) + 3}
                textAnchor="end"
                fontSize={10}
                fill="var(--chart-muted)"
                style={{ fontVariantNumeric: "tabular-nums" }}
              >
                {formatCentsCompact(value, currency)}
              </text>
            )}
          </g>
        ))}

        <path d={areaPath} fill={SERIES_1} opacity={0.1} />
        <path
          d={linePath}
          fill="none"
          stroke={SERIES_1}
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {/* end marker with a surface ring so it reads over the line */}
        <circle
          cx={x(data.length - 1)}
          cy={y(last.netWorthCents)}
          r={4}
          fill={SERIES_1}
          stroke="var(--chart-surface)"
          strokeWidth={2}
        />
        {hovered && hover !== null && (
          <circle
            cx={x(hover)}
            cy={y(hovered.netWorthCents)}
            r={4}
            fill={SERIES_1}
            stroke="var(--chart-surface)"
            strokeWidth={2}
          />
        )}

        {data.map((d, i) => (
          <g key={d.month}>
            {(data.length <= 8 || i % 2 === 0) && (
              <text
                x={x(i)}
                y={PAD_TOP + PLOT_H + 15}
                textAnchor="middle"
                fontSize={10}
                fill="var(--chart-muted)"
              >
                {monthLabel(d.month)}
              </text>
            )}
            <rect
              x={GUTTER + band * i}
              y={PAD_TOP}
              width={band}
              height={PLOT_H}
              fill="transparent"
              tabIndex={0}
              aria-label={`${d.month}: ${formatCents(d.netWorthCents, currency)}`}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
              onFocus={() => setHover(i)}
              onBlur={() => setHover(null)}
            />
          </g>
        ))}
      </svg>

      {hovered && hover !== null && (
        <div
          className="pointer-events-none absolute top-0 z-10 -translate-x-1/2 rounded-md bg-zinc-900 px-2.5 py-1.5 text-xs text-white shadow dark:bg-zinc-700"
          style={{ left: `${((x(hover) / W) * 100).toFixed(2)}%` }}
        >
          <p className="mb-0.5 font-medium">{hovered.month}</p>
          <p>{formatCents(hovered.netWorthCents, currency)}</p>
        </div>
      )}
    </div>
  );
}
