import type { PrismaService } from '../prisma.service';
import { TelegramService } from './telegram.service';

type Row = {
  label: string;
  dueDate: Date | null;
  amountCents: number | null;
  currency: string | null;
  installmentsTotal: number | null;
  installmentsPaid: number | null;
};

function serviceFor(rows: Row[]) {
  let captured: { lte?: Date } | undefined;
  const prisma = {
    user: {
      findUnique: () =>
        Promise.resolve({
          id: 'u1',
          telegramChatId: '55',
          baseCurrency: 'EUR',
        }),
    },
    reminder: {
      findMany: ({ where }: { where: { dueDate?: { lte?: Date } } }) => {
        captured = where.dueDate;
        const limit = where.dueDate?.lte;
        return Promise.resolve(
          rows
            .filter((r) => !limit || (r.dueDate && r.dueDate <= limit))
            .sort(
              (a, b) =>
                (a.dueDate?.getTime() ?? 0) - (b.dueDate?.getTime() ?? 0),
            ),
        );
      },
    },
  } as unknown as PrismaService;
  return {
    service: new TelegramService(prisma, null as never, null as never),
    horizon: () => captured?.lte,
  };
}

const at = (iso: string, over: Partial<Row> = {}): Row => ({
  label: 'Bill',
  dueDate: new Date(`${iso}T00:00:00Z`),
  amountCents: 1000,
  currency: 'EUR',
  installmentsTotal: null,
  installmentsPaid: null,
  ...over,
});

describe('TelegramService.listDueReminders', () => {
  const today = new Date();
  const plus = (n: number) => {
    const d = new Date(today);
    d.setDate(d.getDate() + n);
    return d.toISOString().slice(0, 10);
  };

  it('lists what is due, soonest first', async () => {
    const { service } = serviceFor([
      at(plus(7), { label: 'Rent' }),
      at(plus(2), { label: 'Netflix' }),
    ]);
    const text = await service.listDueReminders('55');
    expect(text.indexOf('Netflix')).toBeLessThan(text.indexOf('Rent'));
    expect(text).toContain('in 2 days');
  });

  // Nudges go quiet once a payment is late, so a missed one can sit unseen.
  // An explicitly requested list is where it has to come back.
  it('surfaces overdue reminders and counts them in the header', async () => {
    const { service } = serviceFor([
      at(plus(-11), { label: 'Netflix' }),
      at(plus(3), { label: 'Rent' }),
    ]);
    const text = await service.listDueReminders('55');
    expect(text).toContain('1 overdue');
    expect(text).toContain('11 days overdue');
    // Overdue leads, regardless of the window.
    expect(text.indexOf('Netflix')).toBeLessThan(text.indexOf('Rent'));
  });

  it('shows which installment is next', async () => {
    const { service } = serviceFor([
      at(plus(1), {
        label: 'TV',
        installmentsTotal: 12,
        installmentsPaid: 3,
      }),
    ]);
    expect(await service.listDueReminders('55')).toContain('4/12');
  });

  it('honours a custom window', async () => {
    const { service, horizon } = serviceFor([at(plus(20), { label: 'Later' })]);
    expect(await service.listDueReminders('55', 10)).toContain('Nothing due');
    expect(await service.listDueReminders('55', 30)).toContain('Later');
    expect(horizon()).toBeInstanceOf(Date);
  });

  it('says so when nothing is coming up', async () => {
    const { service } = serviceFor([]);
    expect(await service.listDueReminders('55')).toContain('Nothing due');
  });
});
