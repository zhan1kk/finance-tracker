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
  FOREIGN_CURRENCIES,
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
    return toBase(amount, currency, await this.resolveRate(userId, currency, date));
  }

  /**
   * A converter with the currency's rates preloaded once — for batch inserts
   * (recurring occurrences, import commits) that convert many rows.
   */
  async converterFor(userId: string, currency: string): Promise<Converter> {
    if (currency === BASE_CURRENCY) return (_date, amount) => amount;
    const rates = await this.ratesFor(userId, currency);
    return (date, amount) => toBase(amount, currency, pickRate(rates, date, currency));
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
  async setRate(userId: string, currency: string, dateISO: string, rate: number) {
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

  /** Every supported foreign currency with the user's exchange-fee spread. */
  async listPreferences(userId: string) {
    const prefs = await this.prisma.currencyPreference.findMany({
      where: { userId },
      select: { currency: true, spreadPct: true },
    });
    const byCurrency = new Map(prefs.map((p) => [p.currency, p.spreadPct]));
    return {
      baseCurrency: BASE_CURRENCY,
      currencies: FOREIGN_CURRENCIES.map((currency) => ({
        currency,
        spreadPct: byCurrency.get(currency) ?? 0,
      })),
    };
  }

  /** Sets the exchange-fee spread (0–MAX) for a currency. */
  async setSpread(userId: string, currency: string, spreadPct: number) {
    if (!FOREIGN_CURRENCIES.includes(currency)) {
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
  async syncRate(userId: string, currency: string) {
    if (!FOREIGN_CURRENCIES.includes(currency)) {
      throw new BadRequestException(`Unsupported currency: ${currency}`);
    }
    const mid = await fetchMidRate(currency);
    const pref = await this.prisma.currencyPreference.findUnique({
      where: { userId_currency: { userId, currency } },
      select: { spreadPct: true },
    });
    const spreadPct = pref?.spreadPct ?? 0;
    const rate = applySpread(mid, spreadPct);
    const today = new Date().toISOString().slice(0, 10);
    const result = await this.setRate(userId, currency, today, rate);
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
async function fetchMidRate(currency: string): Promise<number> {
  const code = currency.toLowerCase();
  const urls = [
    'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/eur.json',
    'https://latest.currency-api.pages.dev/v1/currencies/eur.json',
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
