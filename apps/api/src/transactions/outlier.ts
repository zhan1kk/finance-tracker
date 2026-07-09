export type OutlierVerdict = {
  direction: 'high' | 'low';
  /** Typical amount for this subcategory (median, cents). */
  medianCents: number;
};

const MIN_SAMPLE = 8;
/** Modified z-score cutoff (Iglewicz–Hoaglin recommend 3.5). */
const THRESHOLD = 3.5;
/** Consistency constant relating MAD to the standard deviation. */
const MAD_SCALE = 0.6745;

/**
 * Median + MAD outlier check (robust to the skew of spending data). Returns a
 * verdict only when `candidate` clearly deviates from the history; null means
 * "unremarkable" — including when there is too little history to judge.
 */
export function checkOutlier(
  history: number[],
  candidate: number,
): OutlierVerdict | null {
  if (history.length < MIN_SAMPLE) {
    return null;
  }
  const med = median(history);
  const mad = median(history.map((a) => Math.abs(a - med)));

  if (mad === 0) {
    // Perfectly uniform history (e.g. a fixed subscription): flag any clear
    // departure instead of dividing by zero.
    if (candidate > med * 2) return { direction: 'high', medianCents: med };
    if (candidate < med / 2) return { direction: 'low', medianCents: med };
    return null;
  }

  const z = (MAD_SCALE * (candidate - med)) / mad;
  if (Math.abs(z) < THRESHOLD) {
    return null;
  }
  return { direction: z > 0 ? 'high' : 'low', medianCents: med };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}
