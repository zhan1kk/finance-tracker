import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma.service';

/**
 * Documented behaviour (README + PLAN.md) that the main suite does not pin
 * down: exact recurring dates, budget edges, export safety, immutable fields,
 * and imports that cannot be committed or undone twice.
 */
describe('Contracts (e2e)', () => {
  let app: INestApplication<App>;
  let http: App;
  let token: string;
  let accountId: string;
  let groceriesId: string;
  let booksId: string;

  type Method = 'get' | 'post' | 'patch' | 'put' | 'delete';
  const api = (method: Method, path: string, body?: object) => {
    const req = request(http)
      [method](path)
      .set('Authorization', `Bearer ${token}`);
    return body ? req.send(body) : req;
  };
  const ok = async <T = Record<string, unknown> & { id: string }>(
    method: Method,
    path: string,
    body?: object,
  ): Promise<T> => {
    const res = await api(method, path, body);
    if (res.status >= 300) {
      throw new Error(
        `${method.toUpperCase()} ${path} → ${res.status}: ${JSON.stringify(res.body)}`,
      );
    }
    return res.body as T;
  };

  const createAccount = (name: string, initialBalance = 100_000) =>
    ok('post', '/accounts', {
      name,
      type: 'checking',
      currency: 'EUR',
      initialBalance,
    }).then((a) => a.id);
  const balanceOf = async (id: string) =>
    (await ok<{ balance: number }>('get', `/accounts/${id}`)).balance;
  const expense = (body: Record<string, unknown>) =>
    ok('post', '/transactions', {
      type: 'EXPENSE',
      date: today,
      accountId,
      subcategoryId: groceriesId,
      ...body,
    });

  const today = new Date().toISOString().slice(0, 10);
  const thisMonth = today.slice(0, 7);

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication({ bodyParser: false });
    configureApp(app);
    await app.init();
    await app.listen(0);
    http = app.getHttpServer();
  });

  beforeEach(async () => {
    await app
      .get(PrismaService)
      .$executeRawUnsafe(
        'TRUNCATE "Transaction", "Account", "Subcategory", "RefreshToken", "User" CASCADE',
      );
    token = (
      await request(http)
        .post('/auth/register')
        .send({ email: 'contracts@example.com', password: 'password123' })
        .expect(201)
    ).body.accessToken as string;
    accountId = await createAccount('Main');
    groceriesId = (
      await ok('post', '/subcategories', {
        name: 'Quokka Snacks',
        category: 'Expenses',
      })
    ).id;
    booksId = (
      await ok('post', '/subcategories', {
        name: 'Quokka Reads',
        category: 'Expenses',
      })
    ).id;
  });

  afterAll(async () => {
    await app.close();
  });

  describe('recurring rules', () => {
    type Txn = {
      date: string;
      amount: number;
      type: string;
      accountId: string;
      subcategoryId: string;
      recurringRuleId: string | null;
    };
    const postedDates = async (body: Record<string, unknown>) => {
      const rule = await ok('post', '/recurring', {
        type: 'EXPENSE',
        amount: 1_000,
        accountId,
        subcategoryId: groceriesId,
        ...body,
      });
      await ok('post', '/recurring/run');
      const { items } = await ok<{ items: Txn[] }>(
        'get',
        '/transactions?pageSize=100',
      );
      const mine = items.filter((t) => t.recurringRuleId === rule.id);
      return mine.map((t) => t.date.slice(0, 10)).sort();
    };

    it('anchors a month-end rule to the month end, without drifting', async () => {
      expect(
        await postedDates({
          cadence: 'MONTHLY',
          startDate: '2024-01-31',
          maxOccurrences: 4,
        }),
      ).toEqual(['2024-01-31', '2024-02-29', '2024-03-31', '2024-04-30']);
    });

    it('steps by the interval for daily, weekly and yearly rules', async () => {
      expect(
        await postedDates({
          cadence: 'DAILY',
          interval: 3,
          startDate: '2024-01-30',
          maxOccurrences: 3,
        }),
      ).toEqual(['2024-01-30', '2024-02-02', '2024-02-05']);
      expect(
        await postedDates({
          cadence: 'WEEKLY',
          interval: 2,
          startDate: '2024-01-01',
          maxOccurrences: 3,
        }),
      ).toEqual(['2024-01-01', '2024-01-15', '2024-01-29']);
      expect(
        await postedDates({
          cadence: 'YEARLY',
          startDate: '2024-02-29',
          maxOccurrences: 3,
        }),
      ).toEqual(['2024-02-29', '2025-02-28', '2026-02-28']);
    });

    it('posts on the end date itself, and not after it', async () => {
      expect(
        await postedDates({
          cadence: 'MONTHLY',
          startDate: '2020-01-01',
          endDate: '2020-03-01',
        }),
      ).toEqual(['2020-01-01', '2020-02-01', '2020-03-01']);
    });

    it('books each occurrence exactly as the rule says, linked back to it', async () => {
      const rule = await ok('post', '/recurring', {
        type: 'EXPENSE',
        amount: 4_321,
        accountId,
        subcategoryId: booksId,
        cadence: 'MONTHLY',
        startDate: '2024-01-15',
        maxOccurrences: 2,
      });
      await ok('post', '/recurring/run');
      const { items } = await ok<{ items: Txn[] }>('get', '/transactions');
      expect(items).toHaveLength(2);
      for (const t of items) {
        expect(t).toMatchObject({
          type: 'EXPENSE',
          amount: 4_321,
          accountId,
          subcategoryId: booksId,
          recurringRuleId: rule.id,
        });
      }
      expect(await balanceOf(accountId)).toBe(100_000 - 2 * 4_321);
    });

    it('rejects a rule that could never be valid', async () => {
      const base = {
        type: 'EXPENSE',
        amount: 1_000,
        accountId,
        subcategoryId: groceriesId,
        cadence: 'MONTHLY',
        startDate: '2024-01-01',
      };
      const bad: Record<string, unknown>[] = [
        { amount: 0 },
        { amount: -500 },
        { amount: 10.5 },
        { interval: 0 },
        { maxOccurrences: 0 },
        { cadence: 'HOURLY' },
        { startDate: 'someday' },
        { endDate: '2023-12-31' }, // before the start
      ];
      const accepted: string[] = [];
      for (const patch of bad) {
        const res = await api('post', '/recurring', { ...base, ...patch });
        if (res.status !== 400)
          accepted.push(`${JSON.stringify(patch)} → ${res.status}`);
      }
      expect(accepted).toEqual([]);
      expect(await ok<unknown[]>('get', '/recurring')).toEqual([]);
    });
  });

  describe('budgets', () => {
    type Budget = { id: string; spentCents: number; overBudget: boolean };
    const budgets = () => ok<Budget[]>('get', '/budgets');

    it('is not over budget at exactly the limit, and is one cent past it', async () => {
      const { id } = await ok('post', '/budgets', {
        monthlyLimit: 10_000,
        subcategoryId: groceriesId,
      });
      await expense({ amount: 10_000 });
      expect((await budgets()).find((b) => b.id === id)).toMatchObject({
        spentCents: 10_000,
        remainingCents: 0,
        overBudget: false,
      });
      await expense({ amount: 1 });
      expect((await budgets()).find((b) => b.id === id)).toMatchObject({
        spentCents: 10_001,
        overBudget: true,
      });
    });

    it('counts every subcategory of a category budget, and nothing outside it', async () => {
      const { id } = await ok('post', '/budgets', {
        monthlyLimit: 50_000,
        category: 'Expenses',
      });
      const bills = (
        await ok('post', '/subcategories', {
          name: 'QA Water',
          category: 'Bills',
        })
      ).id;
      await expense({ amount: 1_000 });
      await expense({ amount: 2_000, subcategoryId: booksId });
      await expense({ amount: 4_000, subcategoryId: bills });
      expect((await budgets()).find((b) => b.id === id)?.spentCents).toBe(
        3_000,
      );
    });

    it("counts only this month's spending, and only its own subcategory", async () => {
      const { id } = await ok('post', '/budgets', {
        monthlyLimit: 10_000,
        subcategoryId: groceriesId,
      });
      const lastMonth = new Date(`${thisMonth}-15T00:00:00Z`);
      lastMonth.setUTCMonth(lastMonth.getUTCMonth() - 1);
      await expense({
        amount: 7_000,
        date: lastMonth.toISOString().slice(0, 10),
      });
      await expense({ amount: 3_000, subcategoryId: booksId });
      await expense({ amount: 500 });
      expect((await budgets()).find((b) => b.id === id)?.spentCents).toBe(500);
    });
  });

  describe('transactions CSV export', () => {
    /** RFC 4180: quoted fields, doubled quotes, newlines inside quotes. */
    const parseCsv = (text: string): string[][] => {
      const rows: string[][] = [];
      let row: string[] = [];
      let cell = '';
      let quoted = false;
      const endCell = () => {
        row.push(cell);
        cell = '';
      };
      const endRow = () => {
        endCell();
        rows.push(row);
        row = [];
      };
      for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (quoted && c === '"' && text[i + 1] === '"') {
          cell += '"';
          i++;
        } else if (c === '"') {
          quoted = !quoted;
        } else if (quoted) {
          cell += c;
        } else if (c === ',') {
          endCell();
        } else if (c === '\n' || c === '\r') {
          if (c === '\r' && text[i + 1] === '\n') i++;
          endRow();
        } else {
          cell += c;
        }
      }
      if (cell || row.length) endRow();
      return rows;
    };
    const exportRows = async () => {
      const res = await api('get', '/reports/transactions.csv').expect(200);
      const [header, ...rows] = parseCsv(res.text.replace(/^\uFEFF/, ''));
      return rows
        .filter((r) => r.length > 1)
        .map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])));
    };

    it('defuses every formula prefix in descriptions', async () => {
      for (const d of ['=1+1', '+cmd', '-2+3', '@SUM(1)']) {
        await expense({ amount: 100, description: d });
      }
      const descriptions = (await exportRows()).map((r) => r.Description);
      expect(descriptions.sort()).toEqual([
        "'+cmd",
        "'-2+3",
        "'=1+1",
        "'@SUM(1)",
      ]);
    });

    it('defuses account and category names too, which users also type', async () => {
      const evilAccount = await createAccount('=HYPERLINK("x")', 0);
      const evilSub = (
        await ok('post', '/subcategories', {
          name: '@evil',
          category: 'Expenses',
        })
      ).id;
      await expense({
        amount: 100,
        accountId: evilAccount,
        subcategoryId: evilSub,
      });
      const [row] = await exportRows();
      expect(row.Account).toBe(`'=HYPERLINK("x")`);
      expect(row.Category).toBe("'@evil");
    });

    it('round-trips quotes, commas and newlines, and leaves amounts as numbers', async () => {
      const description = 'He said "hi", then\nleft';
      await expense({ amount: 1_250, description });
      const [row] = await exportRows();
      expect(row.Description).toBe(description);
      expect(row.Amount).toBe('-12.50');
    });
  });

  it('reports net worth for exactly the months asked for, ending this month', async () => {
    const series = await ok<{ month: string }[]>(
      'get',
      '/reports/net-worth?months=3',
    );
    expect(series).toHaveLength(3);
    expect(series[2].month.startsWith(thisMonth)).toBe(true);
  });

  describe('transactions', () => {
    it('keeps type, account and transfer target fixed after creation', async () => {
      const other = await createAccount('Other', 0);
      const third = await createAccount('Third', 0);
      const tx = await expense({ amount: 1_000 });
      const transfer = await ok('post', '/transactions', {
        type: 'TRANSFER',
        date: today,
        amount: 5_000,
        accountId,
        counterAccountId: other,
      });
      const before = await Promise.all(
        [accountId, other, third].map((id) => balanceOf(id)),
      );

      for (const [id, patch] of [
        [tx.id, { type: 'INCOME' }],
        [tx.id, { accountId: other }],
        [transfer.id, { counterAccountId: third }],
        [transfer.id, { accountId: third }],
      ] as const) {
        const res = await api('patch', `/transactions/${id}`, patch);
        expect([200, 400]).toContain(res.status);
      }

      expect(await ok('get', `/transactions/${tx.id}`)).toMatchObject({
        type: 'EXPENSE',
        accountId,
      });
      expect(await ok('get', `/transactions/${transfer.id}`)).toMatchObject({
        accountId,
        counterAccountId: other,
      });
      expect(
        await Promise.all([accountId, other, third].map((id) => balanceOf(id))),
      ).toEqual(before);
    });
  });

  describe('imports', () => {
    const MAPPING = {
      dateColumn: 'Date',
      amountColumn: 'Amount',
      descriptionColumn: 'Description',
      dateFormat: 'ISO',
      decimalSeparator: '.',
      negativeIsExpense: true,
      hasHeader: true,
    };
    const CSV = [
      'Date,Amount,Description',
      '2026-07-01,-12.50,Quokka Snacks 4471',
      '2026-07-02,-30.00,Quokka Reads 9921',
    ].join('\n');

    /** Starts an import and polls its job; the outcome of the job, either way. */
    const runImport = async (body: Record<string, unknown>) => {
      const started = await api('post', '/imports', body);
      if (started.status !== 201)
        return { error: JSON.stringify(started.body) };
      const { jobId } = started.body as { jobId: string };
      for (let i = 0; i < 300; i++) {
        const job = await ok<{
          status: string;
          result?: unknown;
          error?: string;
        }>('get', `/jobs/${jobId}`);
        if (job.status === 'done') {
          return { batch: (job.result as { batch: { id: string } }).batch };
        }
        if (job.status === 'error') return { error: job.error ?? '' };
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error('import job did not finish');
    };
    const stage = async () => {
      const { batch, error } = await runImport({
        accountId,
        filename: 'statement.csv',
        csv: CSV,
        mapping: MAPPING,
      });
      if (!batch) throw new Error(`import failed: ${error}`);
      return batch.id;
    };
    const total = async () =>
      (await ok<{ total: number }>('get', '/transactions')).total;

    it('cannot be committed twice', async () => {
      const id = await stage();
      await ok('post', `/imports/${id}/commit`);
      const again = await api('post', `/imports/${id}/commit`);
      expect(again.status).toBeLessThan(500);

      expect(await total()).toBe(2);
      expect(await balanceOf(accountId)).toBe(100_000 - 1_250 - 3_000);
    });

    // A double click sends a second request before the first returns. Four at
    // once rather than two: the window is narrow, and two only lose the race
    // some of the time.
    const atOnce = (path: string) =>
      Promise.all([1, 2, 3, 4].map(() => api('post', path)));

    it('books one set of transactions when commits arrive at once', async () => {
      const id = await stage();
      const results = await atOnce(`/imports/${id}/commit`);
      expect(results.some((r) => r.status === 201)).toBe(true);
      for (const r of results) expect(r.status).toBeLessThan(500);

      expect(await total()).toBe(2);
      expect(await balanceOf(accountId)).toBe(100_000 - 1_250 - 3_000);
    });

    it('cannot be undone twice', async () => {
      const id = await stage();
      await ok('post', `/imports/${id}/commit`);
      await ok('post', `/imports/${id}/undo`);
      const again = await api('post', `/imports/${id}/undo`);
      expect(again.status).toBeLessThan(500);

      expect(await total()).toBe(0);
      expect(await balanceOf(accountId)).toBe(100_000);
    });

    it('restores the balance once when undos arrive at once', async () => {
      const id = await stage();
      await ok('post', `/imports/${id}/commit`);
      const results = await atOnce(`/imports/${id}/undo`);
      expect(results.some((r) => r.status === 201)).toBe(true);
      for (const r of results) expect(r.status).toBeLessThan(500);

      expect(await total()).toBe(0);
      expect(await balanceOf(accountId)).toBe(100_000);
    });

    it('asks for a column mapping on an account that has none saved', async () => {
      const outcome = await runImport({
        accountId,
        filename: 'x.csv',
        csv: CSV,
      });
      expect(outcome.batch).toBeUndefined();
      expect(outcome.error).toMatch(/mapping/i);
    });
  });
});
