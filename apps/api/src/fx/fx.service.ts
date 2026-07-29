import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import {
  BASE_CURRENCY,
  DEFAULT_RATES,
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

/** Parses a `YYYY-MM-DD` string to a Date at UTC midnight (matches @db.Date). */
function utcDay(dateISO: string): Date {
  const date = new Date(`${dateISO}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) {
    throw new BadRequestException(`Invalid date: ${dateISO}`);
  }
  return date;
}
