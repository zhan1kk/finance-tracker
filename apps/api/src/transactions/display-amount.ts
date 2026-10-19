import { Prisma } from '@prisma/client';

/**
 * One transaction's amount in the reporting currency, as SQL over a row `t`
 * joined to its account `a`.
 *
 * A row whose account is already in the display currency is used as it stands.
 * Converting it to EUR at its own date and back at today's rate moves a number
 * that never needed to change: someone whose accounts are all in dollars,
 * reporting in dollars, would watch their own spending drift by whatever the
 * euro did in between. Everything else converts at the one rate, rounded per
 * row — which is what a mixed-currency total has to do anyway.
 *
 * Shared by the dashboard and the budget card because the two used to round at
 * different points: the dashboard per row, the budget once over the sum. Sum
 * of rounds is not round of sum, so with two or more converted rows in a
 * category the cards could disagree by a cent about the same month. One
 * expression, so they cannot.
 */
export function displayAmountSql(display: {
  currency: string;
  rate: number;
}): Prisma.Sql {
  return display.rate === 1
    ? Prisma.sql`t."amountBase"`
    : Prisma.sql`(CASE WHEN a."currency" = ${display.currency}
        THEN t."amount"
        ELSE ROUND(t."amountBase" * ${display.rate}) END)`;
}
