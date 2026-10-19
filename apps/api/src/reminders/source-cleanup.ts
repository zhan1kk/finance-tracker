import type { Prisma } from '@prisma/client';

/** The reminder kinds that are about one transaction rather than a bill. */
const IOU_KINDS = ['ask', 'pay'];

/**
 * The reminders that go with the transactions they were read from: the open
 * IOUs ("ask" — a friend owes you, "pay" — you owe a friend).
 *
 * Reminder.sourceTransaction is ON DELETE SET NULL, and an "ask" reminder with
 * no source cannot be settled: "Received" links the repayment to that expense,
 * so the button vanished and the reminder sat open with nothing to do. Undoing
 * an import made it worse — re-importing and re-scanning read the same line
 * into a second copy beside the stranded one.
 *
 * Payment reminders are left alone on purpose. A detected bill or an
 * installment plan is about the schedule, not the one line it was spotted in,
 * and reconcile() settles it by category without ever reading its source. Done
 * reminders stay too: they are the record of what was paid.
 *
 * Every path that deletes transactions runs this first, inside the same
 * database transaction — afterwards the link it matches on is already gone.
 */
export function openIousReadFrom(
  transactions: Prisma.TransactionWhereInput,
): Prisma.ReminderWhereInput {
  return {
    done: false,
    kind: { in: IOU_KINDS },
    sourceTransaction: { is: transactions },
  };
}
