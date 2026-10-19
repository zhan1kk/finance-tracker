import type { PrismaService } from '../prisma.service';
import { TelegramService } from './telegram.service';

/**
 * The nudge's Delete goes through the same planDeletion as the web app, so the
 * two cannot disagree about whether a deleted reminder can come back.
 */
function serviceFor(reminder: { sourceTransactionId: string | null } | null) {
  const writes: { op: string; data?: Record<string, unknown> }[] = [];
  const prisma = {
    user: {
      findUnique: () => Promise.resolve({ id: 'u1', telegramChatId: '55' }),
    },
    reminder: {
      findFirst: () =>
        Promise.resolve(
          reminder ? { id: 'r1', label: 'Rent', ...reminder } : null,
        ),
      update: ({ data }: { data: Record<string, unknown> }) => {
        writes.push({ op: 'update', data });
        return Promise.resolve({});
      },
      delete: () => {
        writes.push({ op: 'delete' });
        return Promise.resolve({});
      },
    },
  } as unknown as PrismaService;
  return {
    service: new TelegramService(prisma, null as never, null as never),
    writes,
  };
}

describe('TelegramService.deleteReminder', () => {
  it('hides a scanned reminder, so a later scan cannot recreate it', async () => {
    const { service, writes } = serviceFor({ sourceTransactionId: 't1' });
    await expect(service.deleteReminder('55', 'r1')).resolves.toContain(
      'Deleted: Rent',
    );
    expect(writes).toEqual([
      {
        op: 'update',
        data: { done: true, deletedAt: expect.any(Date) as unknown },
      },
    ]);
  });

  it('removes one typed in by hand', async () => {
    const { service, writes } = serviceFor({ sourceTransactionId: null });
    await service.deleteReminder('55', 'r1');
    expect(writes).toEqual([{ op: 'delete' }]);
  });

  it('says so when it is gone already', async () => {
    const { service, writes } = serviceFor(null);
    await expect(service.deleteReminder('55', 'r1')).resolves.toBe(
      'That reminder is gone already.',
    );
    expect(writes).toEqual([]);
  });
});
