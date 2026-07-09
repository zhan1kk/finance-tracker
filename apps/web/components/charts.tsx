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
        <table className="w-full text-sm">
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
                <td className="py-1.5">{d.month}</td>
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
