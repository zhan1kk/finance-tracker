import type { PrismaService } from '../prisma.service';
import { TelegramService } from './telegram.service';

/**
 * Regression cover for the ✓ button on a reminder nudge.
 *
 * It used to write `done: true` outright, so one tap on an installment plan
 * dismissed the remaining payments instead of booking one. The settlement rules
 * themselves live in settle.spec.ts; what matters here is that this path calls
 * them at all rather than deciding for itself.
 */
type Reminder = {
  id: string;
  label: string;
  dueDate: Date | null;
  cadence: string | null;
  installmentsTotal: number | null;
  installmentsPaid: number | null;
  done: boolean;
};

function serviceFor(reminder: Reminder | null) {
  const updates: Record<string, unknown>[] = [];
  const prisma = {
    user: {
      findUnique: () => Promise.resolve({ id: 'u1', telegramChatId: '55' }),
    },
    reminder: {
      // The service only looks for reminders that are still open.
      findFirst: ({ where }: { where: { done?: boolean } }) =>
        Promise.resolve(
          reminder && where.done === false && reminder.done ? null : reminder,
        ),
      update: ({ data }: { data: Record<string, unknown> }) => {
        updates.push(data);
        return Promise.resolve({});
      },
    },
  } as unknown as PrismaService;

  return {
    service: new TelegramService(prisma, null as never, null as never),
    updates,
  };
}

const plan = (over: Partial<Reminder> = {}): Reminder => ({
  id: 'r1',
  label: 'TV Installment',
  dueDate: new Date('2026-08-24T00:00:00Z'),
  cadence: 'monthly',
  installmentsTotal: 12,
  installmentsPaid: 3,
  done: false,
  ...over,
});

describe('TelegramService.markReminderDone', () => {
  it('books one installment and keeps the plan open', async () => {
    const { service, updates } = serviceFor(plan());
    const reply = await service.markReminderDone('55', 'r1');

    expect(updates).toHaveLength(1);
    // The bug: this used to be { done: true } and nothing else.
    expect(updates[0]).toEqual({
      installmentsPaid: 4,
      done: false,
      dueDate: new Date('2026-09-24T00:00:00Z'),
    });
    expect(reply).toContain('4/12');
    expect(reply).toContain('24 Sep');
  });

  it('completes the plan only on the final payment', async () => {
    const { service, updates } = serviceFor(plan({ installmentsPaid: 11 }));
    const reply = await service.markReminderDone('55', 'r1');

    expect(updates[0]).toMatchObject({ installmentsPaid: 12, done: true });
    expect(reply).toContain('All paid off');
  });

  it('rolls a recurring bill forward instead of dismissing it', async () => {
    const { service, updates } = serviceFor(
      plan({ installmentsTotal: null, installmentsPaid: null, label: 'Rent' }),
    );
    const reply = await service.markReminderDone('55', 'r1');

    expect(updates[0]).toEqual({ dueDate: new Date('2026-09-24T00:00:00Z') });
    expect(updates[0]).not.toHaveProperty('done');
    expect(reply).toContain('Next due 24 Sep');
  });

  it('dismisses a one-off, the only case where done: true is right', async () => {
    const { service, updates } = serviceFor(
      plan({ cadence: null, installmentsTotal: null, installmentsPaid: null }),
    );
    const reply = await service.markReminderDone('55', 'r1');

    expect(updates[0]).toEqual({ done: true });
    expect(reply).toBe('✅ Marked done.');
  });

  it('does nothing when the reminder is already settled', async () => {
    const { service, updates } = serviceFor(plan({ done: true }));
    const reply = await service.markReminderDone('55', 'r1');

    expect(updates).toHaveLength(0);
    expect(reply).toBe('That reminder is gone already.');
  });
});
