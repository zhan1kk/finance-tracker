import { BadRequestException } from '@nestjs/common';
import type { PrismaService } from '../prisma.service';
import { DEFAULT_RATES } from './fx';
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

  // No real request: addCurrency reaches the rate source, and a test that
  // depends on the network passes or fails for reasons that have nothing to
  // do with the check it is making.
  beforeEach(() => {
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ eur: { usd: 1.1582 } }),
    } as Response);
  });
  afterEach(() => jest.restoreAllMocks());

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

/**
 * The seeds are a floor for when the network is unavailable, not a reason not
 * to ask. Skipping the fetch whenever a seed existed left the two most-used
 * currencies as the two that never got a real rate — USD sat on 1.08 against
 * an actual 1.1582, so every dollar amount was stored about 7% wrong.
 */
describe('ensureRate rate source', () => {
  const setup = (fetchResult: Promise<Response>) => {
    const written: { currency: string; rate: number }[] = [];
    const prisma = {
      exchangeRate: {
        count: jest.fn(() => Promise.resolve(0)),
        findMany: jest.fn(() => Promise.resolve([])),
        upsert: jest.fn(
          (args: { create: { currency: string; rate: number } }) => {
            written.push(args.create);
            return Promise.resolve(args.create);
          },
        ),
      },
      currencyPreference: {
        upsert: jest.fn(() => Promise.resolve({})),
        findUnique: jest.fn(() => Promise.resolve(null)),
      },
      transaction: { findMany: jest.fn(() => Promise.resolve([])) },
    } as unknown as PrismaService;
    jest.spyOn(global, 'fetch').mockReturnValue(fetchResult);
    return { fx: new FxService(prisma), written };
  };

  afterEach(() => jest.restoreAllMocks());

  it('prefers a fetched rate over the built-in seed', async () => {
    const { fx, written } = setup(
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ eur: { usd: 1.1582 } }),
      } as Response),
    );

    await fx.ensureRate('u1', 'USD');

    // 1.08 is the seed. Writing it here would mean the fetch was skipped.
    expect(written).toHaveLength(1);
    expect(written[0].rate).toBeCloseTo(1.1582, 4);
  });

  it('falls back to the seed only when the fetch fails', async () => {
    const { fx, written } = setup(Promise.reject(new Error('offline')));

    await fx.ensureRate('u1', 'USD');

    expect(written).toHaveLength(1);
    expect(written[0].rate).toBe(DEFAULT_RATES.USD);
  });
});
