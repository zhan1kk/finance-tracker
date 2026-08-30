import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import {
  applySpread,
  BASE_CURRENCY,
  DEFAULT_RATES,
  isCurrencyCode,
  MAX_SPREAD_PCT,
  pickRate,
  type RatePoint,
  toBase,
} from './fx';

/** Converts an account-currency amount on a given date to base-currency cents. */
export type Converter = (date: Date, amount: number) => number;

@Injectable()
export class FxService {
  constructor(private readonly prisma: PrismaService) {}

  /** All user-set rates for a currency, ascending by date. */
  private ratesFor(userId: string, currency: string): Promise<RatePoint[]> {
    return this.prisma.exchangeRate.findMany({
      where: { userId, currency },
      orderBy: { date: 'asc' },
      select: { date: true, rate: true },
    });
  }

  /**
   * The single rate used to present base-currency aggregates in another
   * currency, plus the date it comes from.
   *
   * One rate, not one per transaction date. An aggregate is already summed in
   * the base currency, so presenting it elsewhere is one multiplication — the
   * parts still add up to the whole, and last month's total does not need a
   * rate for every day it spans. It does mean a past month's figure moves when
   * the rate moves, which is why the date is returned: a converted number that
   * does not say what it was converted at is not a number anyone can check.
   *
   * Ensures a rate exists first, so picking a currency that has never been
   * synced does not silently fall through to a seed value.
   */
  async displayRate(
    userId: string,
    currency: string,
  ): Promise<{ currency: string; rate: number; asOf: string }> {
    const today = new Date();
    if (currency === BASE_CURRENCY) {
      return {
        currency,
        rate: 1,
        asOf: today.toISOString().slice(0, 10),
      };
    }
    await this.ensureRate(userId, currency);
    const rates = await this.ratesFor(userId, currency);
    const latest = rates.at(-1);
    return {
      currency,
      rate: pickRate(rates, today, currency),
      asOf: (latest?.date ?? today).toISOString().slice(0, 10),
    };
  }

  /** The rate in effect for `currency` on `date` (user-set or default). */
  async resolveRate(
    userId: string,
    currency: string,
    date: Date,
  ): Promise<number> {
    if (currency === BASE_CURRENCY) return 1;
    return pickRate(await this.ratesFor(userId, currency), date, currency);
  }

  /** Converts one amount to base currency using the rate effective on `date`. */
  async convert(
    userId: string,
    currency: string,
    date: Date,
    amount: number,
  ): Promise<number> {
    if (currency === BASE_CURRENCY) return amount;
    return toBase(
      amount,
      currency,
      await this.resolveRate(userId, currency, date),
    );
  }

  /**
   * A converter with the currency's rates preloaded once — for batch inserts
   * (recurring occurrences, import commits) that convert many rows.
   */
  async converterFor(userId: string, currency: string): Promise<Converter> {
    if (currency === BASE_CURRENCY) return (_date, amount) => amount;
    const rates = await this.ratesFor(userId, currency);
    return (date, amount) =>
      toBase(amount, currency, pickRate(rates, date, currency));
  }

  /** Rates + the effective-today rate for a currency, for the settings UI. */
  async listRates(userId: string, currency: string) {
    const [rates, effectiveRate] = await Promise.all([
      this.prisma.exchangeRate.findMany({
        where: { userId, currency },
        orderBy: { date: 'desc' },
        select: { id: true, currency: true, date: true, rate: true },
      }),
      this.resolveRate(userId, currency, new Date()),
    ]);
    return {
      currency,
      baseCurrency: BASE_CURRENCY,
      defaultRate: DEFAULT_RATES[currency] ?? null,
      effectiveRate,
      rates,
    };
  }

  /**
   * Sets (upserts) the rate for a currency on a date and recomputes the base
   * amounts of that currency's transactions from that date onward, so a
   * corrected rate immediately fixes historical totals.
   */
  async setRate(
    userId: string,
    currency: string,
    dateISO: string,
    rate: number,
  ) {
    if (currency === BASE_CURRENCY) {
      throw new BadRequestException(
        `${BASE_CURRENCY} is the base currency and needs no rate`,
      );
    }
    if (!Number.isFinite(rate) || rate <= 0) {
      throw new BadRequestException('rate must be a positive number');
    }
    const date = utcDay(dateISO);
    await this.prisma.exchangeRate.upsert({
      where: { userId_currency_date: { userId, currency, date } },
      update: { rate },
      create: { userId, currency, date, rate },
    });
    const recomputed = await this.recomputeFrom(userId, currency, date);
    return { currency, date, rate, recomputed };
  }

  /**
   * The currencies *this* user tracks, with their exchange-fee spreads.
   *
   * Drawn from their own preferences plus any currency their accounts actually
   * use — never from a built-in list, which previously meant every user was
   * shown the currencies one person happened to need.
   */
  async listPreferences(userId: string) {
    const [prefs, accountCurrencies, user] = await Promise.all([
      this.prisma.currencyPreference.findMany({
        where: { userId },
        select: { currency: true, spreadPct: true, autoSync: true },
        orderBy: { currency: 'asc' },
      }),
      this.prisma.account.findMany({
        where: { userId },
        select: { currency: true },
        distinct: ['currency'],
      }),
      this.prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: { baseCurrency: true },
      }),
    ]);
    void user;

    const byCurrency = new Map(prefs.map((p) => [p.currency, p]));
    // An account in a currency you have no preference row for still needs a
    // rate, so surface it rather than letting it convert silently at 1:1.
    //
    // Compared against BASE_CURRENCY, not the user's reporting preference.
    // Every stored rate means "foreign units per 1 EUR" — that is what the
    // whole ledger is anchored to. Filtering by the preference instead meant
    // that choosing USD for reports turned EUR itself into a trackable foreign
    // currency and labelled the rates "1 USD = 1.1582 USD".
    for (const { currency } of accountCurrencies) {
      if (currency !== BASE_CURRENCY && !byCurrency.has(currency)) {
        byCurrency.set(currency, { currency, spreadPct: 0, autoSync: false });
      }
    }
    return {
      baseCurrency: BASE_CURRENCY,
      currencies: [...byCurrency.values()].sort((a, b) =>
        a.currency.localeCompare(b.currency),
      ),
    };
  }

  /**
   * Starts tracking a currency. The rate is fetched immediately: without one,
   * conversions fall back to 1:1 and quietly report nonsense, so a currency
   * that cannot be priced is not worth adding.
   */
  async addCurrency(userId: string, currency: string) {
    if (!isCurrencyCode(currency)) {
      throw new BadRequestException(
        `"${currency}" is not a three-letter currency code (e.g. USD)`,
      );
    }
    const { baseCurrency } = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { baseCurrency: true },
    });
    if (currency === baseCurrency) {
      throw new BadRequestException(
        `${currency} is your base currency — it needs no rate`,
      );
    }
    // Throws a clear 503 when the code is unknown to the rate source, which is
    // also how a typo like "EURO" gets caught.
    const mid = await fetchMidRate(currency);
    await this.prisma.currencyPreference.upsert({
      where: { userId_currency: { userId, currency } },
      update: {},
      create: { userId, currency },
    });
    const today = new Date().toISOString().slice(0, 10);
    await this.setRate(userId, currency, today, mid);
    return { currency, spreadPct: 0, autoSync: false, rate: mid };
  }

  /**
   * Guarantees a usable rate exists before something is priced in `currency`.
   *
   * Without this, an unknown currency converts 1:1 — an account opened with
   * 10,000 TRY would anchor net worth at 10,000 EUR and stay wrong, because the
   * opening balance is frozen at creation. Fetches on demand; if the rate
   * cannot be had, it says so rather than inventing one.
   */
  async ensureRate(userId: string, currency: string): Promise<void> {
    const { baseCurrency } = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { baseCurrency: true },
    });
    if (currency === baseCurrency) return;
    const existing = await this.prisma.exchangeRate.count({
      where: { userId, currency },
    });
    if (existing > 0) return;

    // Fetched even when a seed exists. Skipping the fetch for seeded currencies
    // meant the two most likely to be used were the two that never got a real
    // rate: USD sat on 1.08 against an actual 1.1582, so every dollar amount
    // was stored ~7% wrong until someone synced by hand. The seeds are a floor
    // for when the network is unavailable, not a reason not to ask.
    const mid = await fetchMidRate(currency).catch(
      () => DEFAULT_RATES[currency],
    );
    if (mid === undefined) {
      throw new BadRequestException(
        `No exchange rate for ${currency} yet, and it could not be fetched. Add one under Exchange rates first.`,
      );
    }
    await this.prisma.currencyPreference.upsert({
      where: { userId_currency: { userId, currency } },
      update: {},
      create: { userId, currency },
    });
    await this.setRate(
      userId,
      currency,
      new Date().toISOString().slice(0, 10),
      mid,
    );
  }

  /** Stops tracking a currency. Rates already recorded are left alone. */
  async removeCurrency(userId: string, currency: string) {
    const inUse = await this.prisma.account.count({
      where: { userId, currency },
    });
    if (inUse > 0) {
      throw new BadRequestException(
        `${inUse} account(s) still use ${currency}, so its rate is needed`,
      );
    }
    await this.prisma.currencyPreference.deleteMany({
      where: { userId, currency },
    });
    return { currency, removed: true };
  }

  /** Turns the daily rate fetch on or off for one currency. */
  async setAutoSync(userId: string, currency: string, autoSync: boolean) {
    await this.prisma.currencyPreference.upsert({
      where: { userId_currency: { userId, currency } },
      update: { autoSync },
      create: { userId, currency, autoSync },
    });
    return { currency, autoSync };
  }

  /** Sets the exchange-fee spread (0–MAX) for a currency. */
  async setSpread(userId: string, currency: string, spreadPct: number) {
    if (!isCurrencyCode(currency)) {
      throw new BadRequestException(`Unsupported currency: ${currency}`);
    }
    if (
      !Number.isFinite(spreadPct) ||
      spreadPct < 0 ||
      spreadPct > MAX_SPREAD_PCT
    ) {
      throw new BadRequestException(
        `spreadPct must be between 0 and ${MAX_SPREAD_PCT}`,
      );
    }
    await this.prisma.currencyPreference.upsert({
      where: { userId_currency: { userId, currency } },
      update: { spreadPct },
      create: { userId, currency, spreadPct },
    });
    return { currency, spreadPct };
  }

  /**
   * Fetches today's mid-market rate for `currency` from a free source, applies
   * the user's exchange-fee spread, and stores it effective today (recomputing
   * affected transactions). On-demand — the market call is the only external I/O.
   */
  async syncRate(userId: string, currency: string, dateISO?: string) {
    if (!isCurrencyCode(currency)) {
      throw new BadRequestException(`Unsupported currency: ${currency}`);
    }
    const today = new Date().toISOString().slice(0, 10);
    if (dateISO && dateISO > today) {
      throw new BadRequestException('Cannot fetch a rate for a future date');
    }
    const mid = await fetchMidRate(currency, dateISO);
    const pref = await this.prisma.currencyPreference.findUnique({
      where: { userId_currency: { userId, currency } },
      select: { spreadPct: true },
    });
    const spreadPct = pref?.spreadPct ?? 0;
    const rate = applySpread(mid, spreadPct);
    const result = await this.setRate(userId, currency, dateISO ?? today, rate);
    return { ...result, mid, spreadPct };
  }

  /** Removes a rate override and recomputes affected transactions. */
  async deleteRate(userId: string, id: string) {
    const rate = await this.prisma.exchangeRate.findFirst({
      where: { id, userId },
    });
    if (!rate) return { deleted: false, recomputed: 0 };
    await this.prisma.exchangeRate.delete({ where: { id } });
    const recomputed = await this.recomputeFrom(
      userId,
      rate.currency,
      rate.date,
    );
    return { deleted: true, recomputed };
  }

  /**
   * Recomputes `amountBase` for every transaction in `currency` accounts dated
   * on/after `from`, using the currently effective rates. Only rewrites rows
   * whose value actually changes. Account balances are untouched — they are held
   * in the account's own currency, so a rate change never moves them.
   */
  async recomputeFrom(
    userId: string,
    currency: string,
    from: Date,
  ): Promise<number> {
    if (currency === BASE_CURRENCY) return 0;
    const convert = await this.converterFor(userId, currency);
    const txns = await this.prisma.transaction.findMany({
      where: { account: { is: { userId, currency } }, date: { gte: from } },
      select: { id: true, amount: true, date: true, amountBase: true },
    });
    let recomputed = 0;
    for (const txn of txns) {
      const amountBase = convert(txn.date, txn.amount);
      if (amountBase !== txn.amountBase) {
        await this.prisma.transaction.update({
          where: { id: txn.id },
          data: { amountBase },
        });
        recomputed += 1;
      }
    }
    return recomputed;
  }
}

/**
 * Latest EUR→currency mid-market rate from the free, no-key currency-api
 * (covers KZT, USD, etc.). Tries the CDN then a mirror; throws a clear 503 if
 * both are unreachable so the caller can fall back to a manual rate.
 */
async function fetchMidRate(
  currency: string,
  dateISO?: string,
): Promise<number> {
  const code = currency.toLowerCase();
  // The source publishes a snapshot per day, so a past date can be priced
  // properly instead of being left to the built-in seed rate.
  const version = dateISO ?? 'latest';
  const urls = [
    `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@${version}/v1/currencies/eur.json`,
    dateISO
      ? `https://${dateISO}.currency-api.pages.dev/v1/currencies/eur.json`
      : 'https://latest.currency-api.pages.dev/v1/currencies/eur.json',
  ];
  for (const url of urls) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) continue;
      const json = (await res.json()) as { eur?: Record<string, number> };
      const rate = json.eur?.[code];
      if (typeof rate === 'number' && rate > 0) return rate;
    } catch {
      // Network/parse error — try the next mirror.
    }
  }
  throw new ServiceUnavailableException(
    `Couldn't fetch the ${currency} rate right now — try again, or set it manually.`,
  );
}

/** Parses a `YYYY-MM-DD` string to a Date at UTC midnight (matches @db.Date). */
function utcDay(dateISO: string): Date {
  const date = new Date(`${dateISO}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) {
    throw new BadRequestException(`Invalid date: ${dateISO}`);
  }
  return date;
}
