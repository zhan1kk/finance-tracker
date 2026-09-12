import { BadRequestException } from '@nestjs/common';
import type { PrismaService } from '../prisma.service';
import { FxService } from './fx.service';

/**
 * A rate always means "foreign units per 1 EUR": BASE_CURRENCY is what the
 * ledger is anchored to, and `User.baseCurrency` is only which currency totals
 * are *shown* in. Measuring against the preference made the currency you chose
 * for reports look like the currency amounts were stored in, so the app
 * declined to track a rate for it — and then converted it at 1:1.
 *
 * listPreferences was corrected for this; ensureRate and addCurrency were not.
 */
describe('fx base-currency checks', () => {
  // Reporting in USD, while everything is still stored in EUR.
  const countRates = jest.fn(() => Promise.resolve(1));
  const prisma = {
    user: {
      findUniqueOrThrow: () => Promise.resolve({ baseCurrency: 'USD' }),
    },
    exchangeRate: { count: countRates },
  } as unknown as PrismaService;

  const fx = new FxService(prisma);

  it('still fetches a rate for the currency reports are shown in', async () => {
    await fx.ensureRate('u1', 'USD');
    // Got past the early return: USD is a foreign currency to the ledger,
    // whatever it is to the reports.
    expect(countRates).toHaveBeenCalled();
  });

  it('skips only the currency the ledger is actually stored in', async () => {
    countRates.mockClear();
    await fx.ensureRate('u1', 'EUR');
    expect(countRates).not.toHaveBeenCalled();
  });

  it('refuses to track EUR, and nothing else, as a foreign currency', async () => {
    await expect(fx.addCurrency('u1', 'EUR')).rejects.toBeInstanceOf(
      BadRequestException,
    );

    // USD must get past that refusal. It fails later here — the stub has no
    // rate source and no preference table — so the assertion is on which
    // failure it is, not on reaching the end: anything but "needs no rate"
    // means the check let it through.
    const err = await fx.addCurrency('u1', 'USD').catch((e: unknown) => e);
    expect(String((err as Error).message)).not.toMatch(/needs no rate/);
  });
});
