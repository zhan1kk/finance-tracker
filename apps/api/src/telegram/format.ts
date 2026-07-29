/** Formatting helpers shared by the Telegram services. */

export function money(cents: number, currency: string): string {
  return new Intl.NumberFormat('en', { style: 'currency', currency }).format(
    cents / 100,
  );
}

/**
 * Server-local calendar date. The server's TZ should match the user's (set the
 * TZ env in deployment); UTC would date late-evening captures "yesterday".
 */
export function localTodayISO(): string {
  const date = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * The "Added …" confirmation, shared by the one-shot text capture and the
 * guided picker so both read identically.
 */
export function confirmationText(input: {
  type: 'INCOME' | 'EXPENSE';
  amountCents: number;
  amountBase: number;
  subcategoryName: string;
  description?: string | null;
  account: { name: string; currency: string; balance: number; type: string };
  outlier: { direction: string; medianCents: number } | null;
  baseCurrency: string;
}): string {
  const sign = input.type === 'INCOME' ? '+' : '−';
  const note = input.description ? ` · ${input.description}` : '';
  // Show the base-currency equivalent when booking to a foreign account.
  const equivalent =
    input.account.currency !== input.baseCurrency
      ? ` (≈ ${money(input.amountBase, input.baseCurrency)})`
      : '';
  // Outlier stats are computed in the base currency, so display them there.
  const warning = input.outlier
    ? `\n⚠ Unusually ${input.outlier.direction} for ${input.subcategoryName} (typical ~${money(input.outlier.medianCents, input.baseCurrency)})`
    : '';
  // Negative balances are allowed (never blocked) but worth flagging — except
  // on credit accounts, where negative (= debt owed) is the normal state.
  const belowZero =
    input.account.balance < 0 && input.account.type !== 'credit'
      ? `\n⚠ ${input.account.name} is below zero`
      : '';
  return (
    `Added ${sign}${money(input.amountCents, input.account.currency)}${equivalent} · ${input.subcategoryName}${note}\n` +
    `${input.account.name}: ${money(input.account.balance, input.account.currency)}` +
    warning +
    belowZero
  );
}

/** `offset` days before today, as an ISO date (local). */
export function localDateISO(offset: number): string {
  const date = new Date();
  date.setDate(date.getDate() - offset);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
