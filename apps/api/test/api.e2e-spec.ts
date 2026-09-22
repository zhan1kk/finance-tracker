import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma.service';
import { TelegramService } from '../src/telegram/telegram.service';

describe('API (e2e)', () => {
  /**
   * Starts a CSV import and waits for it. The endpoint returns a job id rather
   * than the result, so that a long categorization is not held open on the
   * connection; tests poll it the same way the browser does.
   */
  const importAndWait = async (
    token: string,
    body: Record<string, unknown>,
  ): Promise<{ status: number; body: unknown; error?: string }> => {
    const started = await request(http)
      .post('/imports')
      .set('Authorization', `Bearer ${token}`)
      .send(body);
    if (started.status !== 201) {
      return { status: started.status, body: started.body };
    }
    const { jobId } = started.body as { jobId: string };
    for (let i = 0; i < 300; i++) {
      const job = await request(http)
        .get(`/jobs/${jobId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      const j = job.body as {
        status: string;
        result?: unknown;
        error?: string;
      };
      if (j.status === 'done') return { status: 201, body: j.result };
      if (j.status === 'error') {
        return { status: 400, body: { message: j.error }, error: j.error };
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error('import job did not finish');
  };

  let app: INestApplication<App>;
  let prisma: PrismaService;
  let http: App;
  let token: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication({ bodyParser: false });
    configureApp(app);
    await app.init();
    // Bind once for the whole suite. Handing supertest an unbound server makes
    // it listen on an ephemeral port and close it per request; under a fast
    // suite those cycles race, and a request lands on a socket being torn down
    // — which surfaced as random 200/404/hang-ups with empty bodies on routes
    // that cannot produce them.
    await app.listen(0);
    prisma = app.get(PrismaService);
    http = app.getHttpServer();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE "Transaction", "Account", "Subcategory", "RefreshToken", "User" CASCADE',
    );
    token = await registerUser('main@example.com');
  });

  afterAll(async () => {
    await app.close();
  });

  /**
   * Asserts a status and, when it differs, puts the server's own response in the
   * failure message.
   *
   * This suite has a known intermittent failure — roughly one run in six, a
   * different test each time, always an unexpected status on a request that
   * should have succeeded. Its cause is still unidentified, and a bare
   * "expected 201, got 401" hides the one clue that would separate the
   * candidates ("Missing access token" means the token never arrived;
   * "Invalid or expired access token" means it was rejected). Keep this until
   * the flake is understood.
   */
  const expectStatus = (res: request.Response, status: number) => {
    if (res.status !== status) {
      throw new Error(
        `Expected ${status}, got ${res.status}. Body: ${JSON.stringify(res.body)}`,
      );
    }
    return res;
  };

  const registerUser = async (email: string): Promise<string> => {
    const res = expectStatus(
      await request(http)
        .post('/auth/register')
        .send({ email, password: 'password123' }),
      201,
    );
    const token = (res.body as { accessToken?: string }).accessToken;
    if (!token) {
      throw new Error(
        `Register returned no token: ${JSON.stringify(res.body)}`,
      );
    }
    return token;
  };

  const createAccount = async (
    initialBalance = 100_000,
    asToken = token,
    extra: Record<string, unknown> = {},
  ) => {
    const res = await request(http)
      .post('/accounts')
      .set('Authorization', `Bearer ${asToken}`)
      .send({
        name: 'Checking',
        type: 'checking',
        currency: 'EUR',
        initialBalance,
        ...extra,
      });
    if (res.status !== 201) {
      // Diagnostic for an intermittent failure: surface the real body/URL.
      console.error(
        `createAccount got ${res.status}; text=${JSON.stringify(res.text)}; headers=${JSON.stringify(res.headers)}`,
      );
    }
    expect(res.status).toBe(201);
    return res.body as { id: string; balance: number };
  };

  // Names must not collide with the defaults seeded on registration.
  const createSubcategory = async (
    name: string,
    category: string,
    asToken = token,
  ) => {
    const res = expectStatus(
      await request(http)
        .post('/subcategories')
        .set('Authorization', `Bearer ${asToken}`)
        .send({ name, category }),
      201,
    );
    return res.body as { id: string };
  };

  const getBalance = async (accountId: string): Promise<number> => {
    const res = await request(http)
      .get(`/accounts/${accountId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    return (res.body as { balance: number }).balance;
  };

  describe('accounts', () => {
    it('creates an account with a balance in cents', async () => {
      const account = await createAccount(150_000);
      expect(account.balance).toBe(150_000);
    });

    it('rejects an invalid account type', async () => {
      await request(http)
        .post('/accounts')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'X', type: 'wallet', currency: 'EUR' })
        .expect(400);
    });

    it('rejects a non-integer balance (cents only)', async () => {
      await request(http)
        .post('/accounts')
        .set('Authorization', `Bearer ${token}`)
        .send({
          name: 'X',
          type: 'cash',
          currency: 'EUR',
          initialBalance: 10.5,
        })
        .expect(400);
    });

    it('validates PATCH bodies (regression: Partial<DTO> skipped validation)', async () => {
      const account = await createAccount();
      await request(http)
        .patch(`/accounts/${account.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ type: 'not-a-type' })
        .expect(400);
    });

    it('does not touch the balance on update (regression: balance reset to 0)', async () => {
      const account = await createAccount(120_000);
      await request(http)
        .patch(`/accounts/${account.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Renamed' })
        .expect(200);
      expect(await getBalance(account.id)).toBe(120_000);
    });

    it('corrects the starting balance, shifting the derived balance by the delta', async () => {
      const account = await createAccount(100_000);
      const expenseId = (await createSubcategory('Coffee', 'Expenses')).id;
      await request(http)
        .post('/transactions')
        .set('Authorization', `Bearer ${token}`)
        .send({
          type: 'EXPENSE',
          date: '2026-07-01',
          amount: 30_000,
          subcategoryId: expenseId,
          accountId: account.id,
        })
        .expect(201);
      expect(await getBalance(account.id)).toBe(70_000);

      // Correcting the opening balance (+20_000) carries into the balance as a
      // delta — it does not reset the balance to the new starting figure.
      await request(http)
        .patch(`/accounts/${account.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ initialBalance: 120_000 })
        .expect(200);
      expect(await getBalance(account.id)).toBe(90_000);
    });

    it('pins an account, sorting it to the top of the list', async () => {
      const first = await createAccount(1_000);
      const second = await createAccount(2_000);
      await request(http)
        .patch(`/accounts/${second.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ pinned: true })
        .expect(200);

      const list = await request(http)
        .get('/accounts')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      const ids = (list.body as { id: string; pinned: boolean }[])
        .map((a) => a.id)
        // Ignore the Cash account registration seeds; this is about ordering.
        .filter((id) => id === first.id || id === second.id);
      // Pinned account leads, regardless of creation order.
      expect(ids).toEqual([second.id, first.id]);
      expect(list.body[0]).toMatchObject({ pinned: true });
    });
  });

  describe('subcategories', () => {
    it('registration seeds defaults; duplicates of them are rejected', async () => {
      const res = await request(http)
        .get('/subcategories')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect((res.body as unknown[]).length).toBeGreaterThanOrEqual(10);

      await request(http)
        .post('/subcategories')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Groceries', category: 'Expenses' })
        .expect(409);
    });

    it('rejects renaming onto an existing name', async () => {
      const { id } = await createSubcategory('Coffee', 'Expenses');
      await request(http)
        .patch(`/subcategories/${id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Groceries' })
        .expect(409);
    });

    it('allows two different users to use the same name', async () => {
      const otherToken = await registerUser('other@example.com');
      await createSubcategory('Coffee', 'Expenses');
      await createSubcategory('Coffee', 'Expenses', otherToken);
    });

    // Renaming is the safe way to reword a category: everything points at the
    // id, so the transaction stays attached and its rules keep working. Only
    // the text the categorizer is shown changes — which is the whole point,
    // since a name like "Kira's food" tells a model nothing about a dog.
    it('renaming keeps the transactions and rules attached', async () => {
      const account = await createAccount();
      const { id } = await createSubcategory(
        "Kira's food and extras",
        'Expenses',
      );
      await request(http)
        .post('/rules')
        .set('Authorization', `Bearer ${token}`)
        .send({ pattern: 'fressnapf', subcategoryId: id })
        .expect(201);
      await request(http)
        .post('/transactions')
        .set('Authorization', `Bearer ${token}`)
        .send({
          type: 'EXPENSE',
          amount: 2500,
          date: '2026-08-01',
          description: 'Fressnapf',
          accountId: account.id,
          subcategoryId: id,
        })
        .expect(201);

      await request(http)
        .patch(`/subcategories/${id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Dog food and vet' })
        .expect(200);

      const tx = await request(http)
        .get('/transactions')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect((tx.body as { items: unknown[] }).items).toContainEqual(
        expect.objectContaining({ subcategoryId: id }),
      );

      const rules = await request(http)
        .get('/rules')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(rules.body as unknown[]).toContainEqual(
        expect.objectContaining({ pattern: 'fressnapf', subcategoryId: id }),
      );
    });

    // The subcategory FK is ON DELETE SET NULL, so a delete used to leave the
    // rule behind pointing at nothing. That rule still matched on import and
    // claimed the row from the categorizer, which then committed with no
    // category and never appeared for review.
    it('deleting takes its rules with it, leaving none without a target', async () => {
      const { id } = await createSubcategory('Doomed', 'Expenses');
      await request(http)
        .post('/rules')
        .set('Authorization', `Bearer ${token}`)
        .send({ pattern: 'doomed merchant', subcategoryId: id })
        .expect(201);

      await request(http)
        .delete(`/subcategories/${id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const rules = await request(http)
        .get('/rules')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      const list = rules.body as {
        pattern: string;
        subcategoryId: string | null;
        counterAccountId: string | null;
        excludeFromStats: boolean;
      }[];
      expect(list.map((r) => r.pattern)).not.toContain('doomed merchant');
      expect(
        list.filter(
          (r) => !r.subcategoryId && !r.counterAccountId && !r.excludeFromStats,
        ),
      ).toEqual([]);
    });

    // The guarantee archiving rests on. Stats group by the subcategoryId on
    // each transaction and never consult the category list, so retiring one
    // cannot move a past total — this asserts it rather than trusting it.
    it('archiving does not change any past total', async () => {
      const account = await createAccount();
      const { id } = await createSubcategory('Retiring soon', 'Expenses');
      await request(http)
        .post('/transactions')
        .set('Authorization', `Bearer ${token}`)
        .send({
          type: 'EXPENSE',
          amount: 4200,
          date: '2026-07-14',
          description: 'Last one',
          accountId: account.id,
          subcategoryId: id,
        })
        .expect(201);

      const stats = () =>
        request(http)
          .get('/transactions/stats')
          .set('Authorization', `Bearer ${token}`)
          .expect(200)
          .then((r) => r.body as unknown);

      const before = await stats();
      await request(http)
        .patch(`/subcategories/${id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ archived: true })
        .expect(200);

      expect(await stats()).toEqual(before);
    });

    it('stops offering an archived category to the categorizer', async () => {
      const account = await createAccount();
      const { id } = await createSubcategory('Bouldering', 'Expenses');
      const mapping = {
        dateColumn: 'Date',
        amountColumn: 'Amount',
        descriptionColumn: 'Description',
        dateFormat: 'ISO',
        decimalSeparator: '.',
        negativeIsExpense: true,
        hasHeader: true,
      };
      type Row = { status: string; subcategory: { name: string } | null };

      // While active, the heuristic name-matches it.
      const first = await importAndWait(token, {
        accountId: account.id,
        filename: 'a.csv',
        csv: 'Date,Amount,Description\n2026-07-05,-18.00,Bouldering\n',
        mapping,
      });
      expect(
        (first.body as { batch: { rows: Row[] } }).batch.rows[0],
      ).toMatchObject({
        status: 'READY',
        subcategory: { name: 'Bouldering' },
      });

      await request(http)
        .patch(`/subcategories/${id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ archived: true })
        .expect(200);

      // Archived, it is not a candidate — so nothing claims the row.
      const second = await importAndWait(token, {
        accountId: account.id,
        filename: 'b.csv',
        csv: 'Date,Amount,Description\n2026-07-06,-19.00,Bouldering\n',
        mapping,
      });
      expect(
        (second.body as { batch: { rows: Row[] } }).batch.rows[0],
      ).toMatchObject({
        status: 'NEEDS_REVIEW',
        subcategory: null,
      });
    });

    // Archived categories are hidden from the list, so a bare "already exists"
    // points at nothing the user can see — a dead end with no way forward.
    it('says so when the name it wants belongs to an archived category', async () => {
      const { id } = await createSubcategory('Retired thing', 'Expenses');
      await request(http)
        .patch(`/subcategories/${id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ archived: true })
        .expect(200);

      const clash = await request(http)
        .post('/subcategories')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Retired thing', category: 'Expenses' })
        .expect(409);
      expect((clash.body as { message: string }).message).toMatch(/archived/i);
      expect((clash.body as { message: string }).message).toMatch(/Restore/i);
    });

    it('still lists an archived category, so history can display it', async () => {
      const { id } = await createSubcategory('Old thing', 'Expenses');
      await request(http)
        .patch(`/subcategories/${id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ archived: true })
        .expect(200);

      const res = await request(http)
        .get('/subcategories')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(res.body as unknown[]).toContainEqual(
        expect.objectContaining({ id, archivedAt: expect.any(String) }),
      );

      // And it comes back, still holding everything it had.
      await request(http)
        .patch(`/subcategories/${id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ archived: false })
        .expect(200);
      const after = await request(http)
        .get(`/subcategories/${id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(after.body).toMatchObject({ id, archivedAt: null });
    });
  });

  // The register form asks this before anyone can authenticate, to decide
  // whether to show an invite field at all. Tests run without INVITE_CODE.
  // The bug this guards: baseCurrency was settable but nothing used it. Every
  // total was computed against a hardcoded EUR while the dashboard printed the
  // preference beside it, so choosing USD produced euro figures wearing a
  // dollar sign. A money app must never let the number and its symbol disagree.
  describe('reporting currency', () => {
    it('reports the currency and rate it converted with', async () => {
      const res = await request(http)
        .get('/transactions/stats')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      const body = res.body as {
        currency: string;
        rate: number;
        rateAsOf: string;
      };
      expect(body.currency).toBe('EUR');
      // Base currency converts by definition at 1, never at a fetched rate.
      expect(body.rate).toBe(1);
      expect(body.rateAsOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('refuses a currency it cannot get a rate for', async () => {
      await request(http)
        .patch('/auth/me')
        .set('Authorization', `Bearer ${token}`)
        .send({ baseCurrency: 'ZZZ' })
        .expect(400);
    });

    it('rejects a malformed code before it reaches the rate lookup', async () => {
      await request(http)
        .patch('/auth/me')
        .set('Authorization', `Bearer ${token}`)
        .send({ baseCurrency: 'euro' })
        .expect(400);
    });
  });

  describe('registration policy', () => {
    it('is readable without a token, and reports the gate', async () => {
      const res = await request(http).get('/auth/registration').expect(200);
      expect(res.body).toEqual({ inviteRequired: false });
    });

    it('lets registration through while no code is configured', async () => {
      await request(http)
        .post('/auth/register')
        .send({
          email: `policy-${Date.now()}@test.local`,
          password: 'password123',
        })
        .expect(201);
    });
  });

  describe('cross-user isolation', () => {
    it("hides another user's account, subcategories and transactions", async () => {
      const account = await createAccount(50_000);
      const subcategory = await createSubcategory('Coffee', 'Expenses');
      await request(http)
        .post('/transactions')
        .set('Authorization', `Bearer ${token}`)
        .send({
          type: 'EXPENSE',
          date: '2026-07-01',
          amount: 1_000,
          subcategoryId: subcategory.id,
          accountId: account.id,
        })
        .expect(201);

      const otherToken = await registerUser('other@example.com');
      const bearer = `Bearer ${otherToken}`;

      await request(http)
        .get(`/accounts/${account.id}`)
        .set('Authorization', bearer)
        .expect(404);
      await request(http)
        .get(`/subcategories/${subcategory.id}`)
        .set('Authorization', bearer)
        .expect(404);

      const accounts = await request(http)
        .get('/accounts')
        .set('Authorization', bearer)
        .expect(200);
      // Their own seeded Cash account and nothing else — never the other user's.
      expect(accounts.body).toEqual([
        expect.objectContaining({ name: 'Cash', type: 'cash' }),
      ]);

      const transactions = await request(http)
        .get('/transactions')
        .set('Authorization', bearer)
        .expect(200);
      expect(transactions.body).toMatchObject({ items: [], total: 0 });
    });

    it("cannot create a transaction against another user's account", async () => {
      const account = await createAccount();
      const otherToken = await registerUser('other@example.com');
      const otherSubcategory = await createSubcategory(
        'Coffee',
        'Expenses',
        otherToken,
      );

      await request(http)
        .post('/transactions')
        .set('Authorization', `Bearer ${otherToken}`)
        .send({
          type: 'EXPENSE',
          date: '2026-07-01',
          amount: 1_000,
          subcategoryId: otherSubcategory.id,
          accountId: account.id,
        })
        .expect(404);
    });

    it("cannot modify or delete another user's account", async () => {
      const account = await createAccount();
      const otherToken = await registerUser('other@example.com');
      const bearer = `Bearer ${otherToken}`;

      await request(http)
        .patch(`/accounts/${account.id}`)
        .set('Authorization', bearer)
        .send({ name: 'Hacked' })
        .expect(404);
      await request(http)
        .delete(`/accounts/${account.id}`)
        .set('Authorization', bearer)
        .expect(404);
    });
  });

  describe('transactions & balance math', () => {
    let accountId: string;
    let incomeId: string;
    let expenseId: string;

    beforeEach(async () => {
      accountId = (await createAccount(100_000)).id;
      incomeId = (await createSubcategory('Bonus', 'Income')).id;
      expenseId = (await createSubcategory('Coffee', 'Expenses')).id;
    });

    const createTransaction = async (
      type: string,
      subcategoryId: string | undefined,
      amount: number,
      expectedStatus = 201,
      extra: Record<string, unknown> = {},
    ) => {
      const res = await request(http)
        .post('/transactions')
        .set('Authorization', `Bearer ${token}`)
        .send({
          type,
          date: '2026-07-01',
          amount,
          subcategoryId,
          accountId,
          ...extra,
        })
        .expect(expectedStatus);
      return res.body as { id: string };
    };

    it('sorts by amount in both directions, and by date by default', async () => {
      // Deliberately out of amount order, and all on the same date so the
      // amount sort is what decides the order rather than the tiebreaker.
      await createTransaction('EXPENSE', expenseId, 2_000);
      await createTransaction('EXPENSE', expenseId, 50_000);
      await createTransaction('EXPENSE', expenseId, 900);

      const amounts = async (query: string) => {
        const res = await request(http)
          .get(`/transactions?${query}`)
          .set('Authorization', `Bearer ${token}`)
          .expect(200);
        return (res.body as { items: { amount: number }[] }).items.map(
          (t) => t.amount,
        );
      };

      expect(await amounts('sort=amount&dir=desc')).toEqual([
        50_000, 2_000, 900,
      ]);
      expect(await amounts('sort=amount&dir=asc')).toEqual([
        900, 2_000, 50_000,
      ]);
      // No sort given: newest first, i.e. reverse insertion order here.
      expect(await amounts('')).toEqual([900, 50_000, 2_000]);
    });

    it('rejects an unknown sort field', async () => {
      await request(http)
        .get('/transactions?sort=description')
        .set('Authorization', `Bearer ${token}`)
        .expect(400);
    });

    it('income increases and expense decreases the account balance', async () => {
      await createTransaction('INCOME', incomeId, 50_000);
      expect(await getBalance(accountId)).toBe(150_000);

      await createTransaction('EXPENSE', expenseId, 2_000);
      expect(await getBalance(accountId)).toBe(148_000);
    });

    it('books an internal move with no category and still moves the balance', async () => {
      // An internal move (own-account transfer / exchange) skips the category
      // requirement but still adjusts the balance.
      await createTransaction('EXPENSE', undefined, 5_000, 201, {
        excludeFromStats: true,
      });
      expect(await getBalance(accountId)).toBe(95_000);
    });

    it('Debts/Savings subcategories now count as expenses', async () => {
      const debtId = (await createSubcategory('Car Loan', 'Debts')).id;
      await createTransaction('EXPENSE', debtId, 10_000);
      expect(await getBalance(accountId)).toBe(90_000);
    });

    it('rejects a missing type', async () => {
      await request(http)
        .post('/transactions')
        .set('Authorization', `Bearer ${token}`)
        .send({
          date: '2026-07-01',
          amount: 1_000,
          subcategoryId: expenseId,
          accountId,
        })
        .expect(400);
    });

    it('rejects a type/category mismatch', async () => {
      await createTransaction('INCOME', expenseId, 1_000, 400);
      await createTransaction('EXPENSE', incomeId, 1_000, 400);
    });

    it('rejects a counter account on income/expense', async () => {
      const other = await createAccount(0, token, { name: 'Other' });
      await createTransaction('EXPENSE', expenseId, 1_000, 400, {
        counterAccountId: other.id,
      });
    });

    it('updating the amount adjusts the balance by the difference', async () => {
      const tx = await createTransaction('EXPENSE', expenseId, 2_000);
      await request(http)
        .patch(`/transactions/${tx.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ amount: 3_000 })
        .expect(200);
      expect(await getBalance(accountId)).toBe(97_000);
    });

    it('rejects changing the subcategory to a mismatched category', async () => {
      const tx = await createTransaction('EXPENSE', expenseId, 2_000);
      await request(http)
        .patch(`/transactions/${tx.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ subcategoryId: incomeId })
        .expect(400);
      expect(await getBalance(accountId)).toBe(98_000);
    });

    it('deleting a transaction reverts its balance effect', async () => {
      const tx = await createTransaction('INCOME', incomeId, 50_000);
      await request(http)
        .delete(`/transactions/${tx.id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(await getBalance(accountId)).toBe(100_000);
    });

    it('rejects zero, negative and fractional amounts', async () => {
      await createTransaction('EXPENSE', expenseId, 0, 400);
      await createTransaction('EXPENSE', expenseId, -500, 400);
      await createTransaction('EXPENSE', expenseId, 10.5, 400);
    });

    it('returns 404 for an unknown subcategory', async () => {
      await createTransaction(
        'EXPENSE',
        '00000000-0000-0000-0000-000000000000',
        1_000,
        404,
      );
    });

    it('refuses to delete an account that still has transactions', async () => {
      await createTransaction('EXPENSE', expenseId, 1_000);
      await request(http)
        .delete(`/accounts/${accountId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(409);
    });

    it('refuses to change a subcategory category once it has transactions', async () => {
      await createTransaction('EXPENSE', expenseId, 1_000);
      await request(http)
        .patch(`/subcategories/${expenseId}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ category: 'Income' })
        .expect(409);
    });

    it('filters and paginates the transaction list', async () => {
      await createTransaction('INCOME', incomeId, 50_000);
      await createTransaction('EXPENSE', expenseId, 1_000, 201, {
        date: '2026-06-15',
        description: 'Morning espresso',
      });
      await createTransaction('EXPENSE', expenseId, 2_000, 201, {
        date: '2026-07-02',
      });

      const list = (
        filters: string,
      ): Promise<{ body: { items: unknown[]; total: number } }> =>
        request(http)
          .get(`/transactions?${filters}`)
          .set('Authorization', `Bearer ${token}`)
          .expect(200);

      expect((await list('type=EXPENSE')).body.total).toBe(2);
      expect((await list('from=2026-07-01')).body.total).toBe(2);
      expect((await list('search=espresso')).body.total).toBe(1);
      expect((await list(`subcategoryId=${incomeId}`)).body.total).toBe(1);

      const page = (await list('page=2&pageSize=2')).body;
      expect(page.total).toBe(3);
      expect(page.items).toHaveLength(1);

      await request(http)
        .get('/transactions?pageSize=1000')
        .set('Authorization', `Bearer ${token}`)
        .expect(400);
    });

    it('refuses to change the currency of an account with transactions', async () => {
      await createTransaction('EXPENSE', expenseId, 1_000);
      await request(http)
        .patch(`/accounts/${accountId}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ currency: 'USD' })
        .expect(409);
    });
  });

  describe('transfers', () => {
    let sourceId: string;
    let targetId: string;

    const transfer = (
      body: Record<string, unknown>,
      expectedStatus = 201,
      asToken = token,
    ) =>
      request(http)
        .post('/transactions')
        .set('Authorization', `Bearer ${asToken}`)
        .send({
          type: 'TRANSFER',
          date: '2026-07-01',
          amount: 30_000,
          accountId: sourceId,
          counterAccountId: targetId,
          ...body,
        })
        .expect(expectedStatus);

    beforeEach(async () => {
      sourceId = (await createAccount(100_000, token, { name: 'Source' })).id;
      targetId = (
        await createAccount(50_000, token, { name: 'Savings', type: 'savings' })
      ).id;
    });

    it('moves money between both accounts', async () => {
      const res = await transfer({});
      expect(res.body).toMatchObject({ type: 'TRANSFER', subcategoryId: null });
      expect(await getBalance(sourceId)).toBe(70_000);
      expect(await getBalance(targetId)).toBe(80_000);
    });

    it('rejects a transfer with a subcategory', async () => {
      const sub = await createSubcategory('Coffee', 'Expenses');
      await transfer({ subcategoryId: sub.id }, 400);
    });

    it('rejects a transfer to the same account', async () => {
      await transfer({ counterAccountId: sourceId }, 400);
    });

    it('rejects a transfer without a destination', async () => {
      await transfer({ counterAccountId: undefined }, 400);
    });

    it("rejects a transfer to another user's account", async () => {
      const otherToken = await registerUser('other@example.com');
      const foreign = await createAccount(0, otherToken);
      await transfer({ counterAccountId: foreign.id }, 404);
    });

    it('rejects a transfer between different currencies', async () => {
      const usd = await createAccount(0, token, {
        name: 'USD account',
        currency: 'USD',
      });
      await transfer({ counterAccountId: usd.id }, 400);
    });

    it('updating the amount adjusts both balances', async () => {
      const res = await transfer({});
      await request(http)
        .patch(`/transactions/${(res.body as { id: string }).id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ amount: 10_000 })
        .expect(200);
      expect(await getBalance(sourceId)).toBe(90_000);
      expect(await getBalance(targetId)).toBe(60_000);
    });

    it('rejects setting a subcategory on an existing transfer', async () => {
      const res = await transfer({});
      const sub = await createSubcategory('Coffee', 'Expenses');
      await request(http)
        .patch(`/transactions/${(res.body as { id: string }).id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ subcategoryId: sub.id })
        .expect(400);
    });

    it('deleting a transfer reverts both balances', async () => {
      const res = await transfer({});
      await request(http)
        .delete(`/transactions/${(res.body as { id: string }).id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(await getBalance(sourceId)).toBe(100_000);
      expect(await getBalance(targetId)).toBe(50_000);
    });

    it('blocks deleting an account that receives transfers', async () => {
      await transfer({});
      await request(http)
        .delete(`/accounts/${targetId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(409);
    });
  });

  describe('reimbursements', () => {
    let accountId: string;
    let incomeId: string;
    let expenseTxId: string;

    beforeEach(async () => {
      accountId = (await createAccount(100_000)).id;
      incomeId = (await createSubcategory('Payback', 'Income')).id;
      const expenseId = (await createSubcategory('Trip', 'Expenses')).id;
      const res = await request(http)
        .post('/transactions')
        .set('Authorization', `Bearer ${token}`)
        .send({
          type: 'EXPENSE',
          date: '2026-07-01',
          amount: 15_000,
          subcategoryId: expenseId,
          accountId,
        })
        .expect(201);
      expenseTxId = (res.body as { id: string }).id;
    });

    const reimburse = (
      parentTransactionId: string,
      expectedStatus = 201,
      extra: Record<string, unknown> = {},
    ) =>
      request(http)
        .post('/transactions')
        .set('Authorization', `Bearer ${token}`)
        .send({
          type: 'INCOME',
          date: '2026-07-02',
          amount: 12_000,
          subcategoryId: incomeId,
          accountId,
          parentTransactionId,
          ...extra,
        })
        .expect(expectedStatus);

    it('links an income to the expense it reimburses', async () => {
      await reimburse(expenseTxId);
      expect(await getBalance(accountId)).toBe(97_000); // 100k - 15k + 12k

      const parent = await request(http)
        .get(`/transactions/${expenseTxId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(
        (parent.body as { reimbursements: unknown[] }).reimbursements,
      ).toHaveLength(1);
    });

    // Which income categories to watch is learned from the links already made,
    // so no fixed list of category names is involved and it works in any
    // language. The risk is the opposite of a missed refund: nagging about a
    // salary, so one stray link must not be enough to start watching.
    describe('unlinked refunds', () => {
      const unlinked = async () => {
        const res = await request(http)
          .get('/transactions/unlinked-reimbursements')
          .set('Authorization', `Bearer ${token}`)
          .expect(200);
        return res.body as { id: string; description: string | null }[];
      };

      const plainIncome = (subcategoryId: string, amount: number) =>
        request(http)
          .post('/transactions')
          .set('Authorization', `Bearer ${token}`)
          .send({
            type: 'INCOME',
            date: '2026-07-03',
            amount,
            subcategoryId,
            accountId,
            description: 'unlinked',
          })
          .expect(201);

      it('stays quiet until a category has been linked twice', async () => {
        await plainIncome(incomeId, 5_000);
        expect(await unlinked()).toEqual([]);

        await reimburse(expenseTxId);
        expect(await unlinked()).toEqual([]); // one link is not a pattern

        await reimburse(expenseTxId);
        expect(await unlinked()).toEqual([
          expect.objectContaining({ description: 'unlinked' }),
        ]);
      });

      it('never reports a category that was only ever plain income', async () => {
        const salary = (await createSubcategory('Consulting fees', 'Income'))
          .id;
        await reimburse(expenseTxId);
        await reimburse(expenseTxId);
        await plainIncome(salary, 200_000);

        const rows = await unlinked();
        expect(rows).toEqual([]);
      });

      it('drops a row from the list once it is linked', async () => {
        await reimburse(expenseTxId);
        await reimburse(expenseTxId);
        await plainIncome(incomeId, 5_000);
        const [row] = await unlinked();
        expect(row).toBeDefined();

        await request(http)
          .patch(`/transactions/${row.id}/reimburses`)
          .set('Authorization', `Bearer ${token}`)
          .send({ parentTransactionId: expenseTxId })
          .expect(200);

        expect(await unlinked()).toEqual([]);
      });
    });

    it('rejects an EXPENSE as a reimbursement', async () => {
      const sub = await createSubcategory('Coffee', 'Expenses');
      await reimburse(expenseTxId, 400, {
        type: 'EXPENSE',
        subcategoryId: sub.id,
      });
    });

    it('rejects linking to a non-expense parent', async () => {
      const income = await reimburse(expenseTxId);
      await reimburse((income.body as { id: string }).id, 400);
    });

    it("rejects linking to another user's transaction", async () => {
      const otherToken = await registerUser('other@example.com');
      const foreignAccount = await createAccount(0, otherToken);
      const foreignSub = await createSubcategory(
        'Trip',
        'Expenses',
        otherToken,
      );
      const foreignExpense = await request(http)
        .post('/transactions')
        .set('Authorization', `Bearer ${otherToken}`)
        .send({
          type: 'EXPENSE',
          date: '2026-07-01',
          amount: 1_000,
          subcategoryId: foreignSub.id,
          accountId: foreignAccount.id,
        })
        .expect(201);

      await reimburse((foreignExpense.body as { id: string }).id, 404);
    });

    it('blocks deleting an expense that has reimbursements', async () => {
      const child = await reimburse(expenseTxId);

      await request(http)
        .delete(`/transactions/${expenseTxId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(409);

      // Deleting the reimbursement first unblocks the parent.
      await request(http)
        .delete(`/transactions/${(child.body as { id: string }).id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      await request(http)
        .delete(`/transactions/${expenseTxId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(await getBalance(accountId)).toBe(100_000);
    });
  });

  describe('balance integrity', () => {
    it('reports zero drift after normal usage and repairs corruption', async () => {
      const source = await createAccount(100_000, token, { name: 'Source' });
      const target = await createAccount(50_000, token, { name: 'Target' });
      const expenseId = (await createSubcategory('Coffee', 'Expenses')).id;

      await request(http)
        .post('/transactions')
        .set('Authorization', `Bearer ${token}`)
        .send({
          type: 'EXPENSE',
          date: '2026-07-01',
          amount: 5_000,
          subcategoryId: expenseId,
          accountId: source.id,
        })
        .expect(201);
      await request(http)
        .post('/transactions')
        .set('Authorization', `Bearer ${token}`)
        .send({
          type: 'TRANSFER',
          date: '2026-07-01',
          amount: 20_000,
          accountId: source.id,
          counterAccountId: target.id,
        })
        .expect(201);

      const clean = await request(http)
        .get('/accounts/integrity')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      for (const entry of clean.body as { drift: number }[]) {
        expect(entry.drift).toBe(0);
      }

      // Simulate corruption directly in the database.
      await prisma.account.update({
        where: { id: source.id },
        data: { balance: { increment: 12_345 } },
      });

      const dirty = await request(http)
        .get('/accounts/integrity')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      const corrupted = (
        dirty.body as { accountId: string; drift: number }[]
      ).find((e) => e.accountId === source.id);
      expect(corrupted?.drift).toBe(12_345);

      const repaired = await request(http)
        .post('/accounts/integrity/repair')
        .set('Authorization', `Bearer ${token}`)
        .expect(201);
      expect(repaired.body as unknown[]).toHaveLength(1);
      expect(await getBalance(source.id)).toBe(75_000); // 100k - 5k - 20k
    });
  });

  describe('stats', () => {
    let accountId: string;
    let salaryId: string;
    let groceriesId: string;
    let rentId: string;

    type Stats = {
      monthly: {
        month: string;
        income: number;
        expense: number;
        count: number;
      }[];
      byCategory: { subcategoryId: string; name: string; amount: number }[];
      incomeByCategory: {
        subcategoryId: string;
        name: string;
        amount: number;
      }[];
    };

    beforeEach(async () => {
      accountId = (await createAccount(500_000)).id;
      salaryId = (await createSubcategory('Paycheck', 'Income')).id;
      groceriesId = (await createSubcategory('Food', 'Expenses')).id;
      rentId = (await createSubcategory('Housing', 'Bills')).id;
    });

    const addTransaction = async (
      body: Record<string, unknown>,
      asToken = token,
    ) => {
      const res = await request(http)
        .post('/transactions')
        .set('Authorization', `Bearer ${asToken}`)
        .send({ accountId, ...body })
        .expect(201);
      return res.body as { id: string };
    };

    const getStats = async (query = '') => {
      const res = await request(http)
        .get(`/transactions/stats${query}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      return res.body as Stats;
    };

    it('groups income and expenses by month and category', async () => {
      await addTransaction({
        type: 'INCOME',
        subcategoryId: salaryId,
        amount: 300_000,
        date: '2026-05-25',
      });
      await addTransaction({
        type: 'EXPENSE',
        subcategoryId: rentId,
        amount: 80_000,
        date: '2026-05-28',
      });
      await addTransaction({
        type: 'EXPENSE',
        subcategoryId: groceriesId,
        amount: 12_000,
        date: '2026-06-02',
      });

      const stats = await getStats();
      expect(stats.monthly).toEqual([
        expect.objectContaining({
          month: '2026-05',
          income: 300_000,
          expense: 80_000,
        }),
        expect.objectContaining({
          month: '2026-06',
          income: 0,
          expense: 12_000,
        }),
      ]);
      expect(stats.byCategory).toEqual([
        expect.objectContaining({ subcategoryId: rentId, amount: 80_000 }),
        expect.objectContaining({ subcategoryId: groceriesId, amount: 12_000 }),
      ]);
      expect(stats.incomeByCategory).toEqual([
        expect.objectContaining({ subcategoryId: salaryId, amount: 300_000 }),
      ]);
    });

    it('excludes transfers', async () => {
      const other = await createAccount(0);
      await addTransaction({
        type: 'TRANSFER',
        counterAccountId: other.id,
        amount: 50_000,
        date: '2026-06-10',
      });

      const stats = await getStats();
      expect(stats.monthly).toEqual([]);
      expect(stats.byCategory).toEqual([]);
    });

    it('nets reimbursements against the parent expense category, not income', async () => {
      const dinner = await addTransaction({
        type: 'EXPENSE',
        subcategoryId: groceriesId,
        amount: 9_000,
        date: '2026-06-05',
      });
      await addTransaction({
        type: 'INCOME',
        subcategoryId: salaryId,
        amount: 3_000,
        date: '2026-07-01',
        parentTransactionId: dinner.id,
      });

      const stats = await getStats();
      // The payback is not income; it reduces the expense it repays, and it does
      // so in that expense's month even though the money arrived in July — so
      // the monthly totals agree with the category breakdown below.
      expect(stats.monthly).toEqual([
        expect.objectContaining({
          month: '2026-06',
          income: 0,
          expense: 6_000,
        }),
      ]);
      expect(stats.byCategory).toEqual([
        expect.objectContaining({ subcategoryId: groceriesId, amount: 6_000 }),
      ]);
      // The payback is a reimbursement, not earnings — excluded from income.
      expect(stats.incomeByCategory).toEqual([]);
    });

    it('credits a later reimbursement to the month of the expense it repays', async () => {
      // Regression: the category breakdown used to range on the payback's own
      // date while crediting it to the parent's category, so a repaid expense
      // stayed at full value in its own month and left a phantom credit in the
      // month the money arrived. Only visible when a period is selected.
      const gear = await addTransaction({
        type: 'EXPENSE',
        subcategoryId: groceriesId,
        amount: 6_600,
        date: '2026-06-14',
      });
      await addTransaction({
        type: 'INCOME',
        subcategoryId: salaryId,
        amount: 6_600,
        date: '2026-07-08',
        parentTransactionId: gear.id,
      });

      const june = await getStats('?from=2026-06-01&to=2026-06-30');
      expect(june.byCategory).toEqual([
        expect.objectContaining({ subcategoryId: groceriesId, amount: 0 }),
      ]);
      // The monthly total tells the same story as the categories — the two
      // views of one month must not disagree.
      expect(june.monthly).toEqual([
        expect.objectContaining({ month: '2026-06', income: 0, expense: 0 }),
      ]);

      // July only received the money; it never had spending in that category.
      const july = await getStats('?from=2026-07-01&to=2026-07-31');
      expect(july.byCategory).toEqual([]);
      expect(july.monthly).toEqual([]);
    });

    it('does not net a reimbursement against an internal (excluded) parent', async () => {
      const parent = await addTransaction({
        type: 'EXPENSE',
        subcategoryId: groceriesId,
        amount: 9_000,
        date: '2026-06-05',
        excludeFromStats: true,
      });
      await addTransaction({
        type: 'INCOME',
        subcategoryId: salaryId,
        amount: 3_000,
        date: '2026-06-06',
        parentTransactionId: parent.id,
      });

      const stats = await getStats();
      // The internal expense is excluded; its payback must not subtract either,
      // or spending would carry a phantom -3000 credit.
      expect(stats.monthly).toEqual([
        expect.objectContaining({ month: '2026-06', income: 0, expense: 0 }),
      ]);
      expect(stats.byCategory).toEqual([]);
      expect(stats.incomeByCategory).toEqual([]);
    });

    it('excludes internal moves from income and category breakdowns', async () => {
      await addTransaction({
        type: 'INCOME',
        subcategoryId: salaryId,
        amount: 100_000,
        date: '2026-06-01',
      });
      // An internal move (e.g. money arriving from your own other account).
      await addTransaction({
        type: 'INCOME',
        subcategoryId: salaryId,
        amount: 500_000,
        date: '2026-06-02',
        excludeFromStats: true,
      });

      const stats = await getStats();
      // Only the real €1000 counts as income; the internal €5000 does not.
      expect(stats.monthly).toEqual([
        expect.objectContaining({
          month: '2026-06',
          income: 100_000,
          expense: 0,
        }),
      ]);
      expect(stats.incomeByCategory).toEqual([
        expect.objectContaining({ subcategoryId: salaryId, amount: 100_000 }),
      ]);
      // But both moved the balance: 500k start + 100k + 500k.
      expect(await getBalance(accountId)).toBe(1_100_000);
    });

    // The reason MonthlyStat carries a count at all: a month with no spending
    // and a month whose statement was never imported are otherwise identical,
    // and the dashboard averages recent months into a baseline. Counting one
    // transaction as a full month drags "typical" down and reports overspending
    // that did not happen.
    it('counts transactions per month, so an empty month can be told apart', async () => {
      await addTransaction({
        type: 'EXPENSE',
        date: '2026-06-02',
        amount: 1_000,
        subcategoryId: groceriesId,
      });
      await addTransaction({
        type: 'EXPENSE',
        date: '2026-06-03',
        amount: 2_000,
        subcategoryId: groceriesId,
      });
      await addTransaction({
        type: 'INCOME',
        date: '2026-07-01',
        amount: 5_000,
        subcategoryId: salaryId,
      });

      const stats = await getStats('?from=2026-06-01&to=2026-07-31');
      const june = stats.monthly.find((m) => m.month === '2026-06');
      const july = stats.monthly.find((m) => m.month === '2026-07');
      expect(june?.count).toBe(2);
      // Income counts too: the question is whether anything was recorded, not
      // whether anything was spent.
      expect(july?.count).toBe(1);
      expect(july?.expense).toBe(0);
    });

    it('respects the from/to range', async () => {
      await addTransaction({
        type: 'EXPENSE',
        subcategoryId: groceriesId,
        amount: 1_000,
        date: '2026-05-15',
      });
      await addTransaction({
        type: 'EXPENSE',
        subcategoryId: groceriesId,
        amount: 2_000,
        date: '2026-06-15',
      });

      const stats = await getStats('?from=2026-06-01&to=2026-06-30');
      expect(stats.monthly).toEqual([
        expect.objectContaining({
          month: '2026-06',
          income: 0,
          expense: 2_000,
        }),
      ]);
      expect(stats.byCategory).toEqual([
        expect.objectContaining({ amount: 2_000 }),
      ]);
    });

    it("only counts the requesting user's transactions", async () => {
      const otherToken = await registerUser('stats-other@example.com');
      const otherAccount = await createAccount(0, otherToken);
      const otherSub = await createSubcategory(
        'Their food',
        'Expenses',
        otherToken,
      );
      await addTransaction(
        {
          accountId: otherAccount.id,
          type: 'EXPENSE',
          subcategoryId: otherSub.id,
          amount: 5_000,
          date: '2026-06-01',
        },
        otherToken,
      );

      const stats = await getStats();
      expect(stats.monthly).toEqual([]);
      expect(stats.byCategory).toEqual([]);
    });
  });

  describe('telegram', () => {
    const CHAT = '424242';

    const linkChat = async (chatId = CHAT) => {
      const res = await request(http)
        .post('/telegram/link-code')
        .set('Authorization', `Bearer ${token}`)
        .expect(201);
      const { code } = res.body as { code: string };
      expect(code).toMatch(/^[0-9a-f]{8}$/);
      expect(await telegram().linkChat(code, chatId)).toBe(true);
      return code;
    };

    const telegram = () => app.get(TelegramService);

    it('links a chat with a one-time code (invalid and reused codes fail)', async () => {
      expect(await telegram().linkChat('deadbeef', CHAT)).toBe(false);

      const code = await linkChat();
      // Single-use: the same code cannot link a second chat.
      expect(await telegram().linkChat(code, '999')).toBe(false);

      const settings = await request(http)
        .get('/telegram/settings')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(settings.body).toMatchObject({ linked: true });
    });

    it('sets a default account but rejects a foreign one', async () => {
      const account = await createAccount(10_000);
      const updated = await request(http)
        .patch('/telegram/settings')
        .set('Authorization', `Bearer ${token}`)
        .send({ defaultAccountId: account.id })
        .expect(200);
      expect(updated.body).toMatchObject({ defaultAccountId: account.id });

      const otherToken = await registerUser('tg-other@example.com');
      const foreign = await createAccount(0, otherToken);
      await request(http)
        .patch('/telegram/settings')
        .set('Authorization', `Bearer ${token}`)
        .send({ defaultAccountId: foreign.id })
        .expect(404);
    });

    it('captures an expense from a linked chat and undoes it', async () => {
      const account = await createAccount(10_000);
      await linkChat();
      await request(http)
        .patch('/telegram/settings')
        .set('Authorization', `Bearer ${token}`)
        .send({ defaultAccountId: account.id })
        .expect(200);

      const garbage = await telegram().capture(CHAT, 'what is my balance?');
      expect(garbage.ok).toBe(false);

      const noMatch = await telegram().capture(CHAT, '5 - nonexistentcategory');
      expect(noMatch.ok).toBe(false);

      // "grocer" fuzzy-matches the seeded "Groceries" subcategory.
      const result = await telegram().capture(
        CHAT,
        '12.50 - grocer - coffee beans',
      );
      expect(result.ok).toBe(true);
      expect(await getBalance(account.id)).toBe(8_750);

      if (result.ok) {
        await telegram().undoCapture(CHAT, result.transactionId);
      }
      expect(await getBalance(account.id)).toBe(10_000);
    });

    it('captures multi-word categories and explicit dates', async () => {
      const account = await createAccount(10_000);
      await linkChat();
      await request(http)
        .patch('/telegram/settings')
        .set('Authorization', `Bearer ${token}`)
        .send({ defaultAccountId: account.id })
        .expect(200);

      // "dining out" is a seeded default subcategory — the old whitespace
      // format parsed this as category "dining" + description "out".
      const multiWord = await telegram().capture(
        CHAT,
        '40 - dining out - lunch with friends',
      );
      expect(multiWord.ok).toBe(true);
      expect(multiWord.ok && multiWord.text).toContain('Dining Out');

      const dated = await telegram().capture(
        CHAT,
        '3 - grocer - snack - 2026-01-15',
      );
      expect(dated.ok).toBe(true);
      const onDate = await request(http)
        .get('/transactions?from=2026-01-15&to=2026-01-15')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(onDate.body).toMatchObject({ total: 1 });
    });

    it('switches the capture account via /account', async () => {
      const first = await createAccount(10_000);
      // Not 'Cash': registration already seeds an account by that name.
      const second = await createAccount(0, token, { name: 'Wallet' });
      await linkChat();
      await request(http)
        .patch('/telegram/settings')
        .set('Authorization', `Bearer ${token}`)
        .send({ defaultAccountId: first.id })
        .expect(200);

      const listed = await telegram().listAccounts(CHAT);
      expect(listed?.accounts.map((a) => a.name).sort()).toEqual([
        'Cash',
        'Checking',
        'Wallet',
      ]);
      expect(listed?.defaultAccountId).toBe(first.id);

      expect(await telegram().setDefaultAccount(CHAT, second.id)).toContain(
        'Wallet',
      );
      const capture = await telegram().capture(CHAT, '5 - grocer');
      expect(capture.ok).toBe(true);
      expect(await getBalance(second.id)).toBe(-500);
      expect(await getBalance(first.id)).toBe(10_000);

      // Another user's account cannot become the target.
      const otherToken = await registerUser('acct-other@example.com');
      const foreign = await createAccount(0, otherToken);
      expect(await telegram().setDefaultAccount(CHAT, foreign.id)).toContain(
        'not found',
      );
    });

    it('rejects captures from unlinked chats and unlinks cleanly', async () => {
      const unlinked = await telegram().capture('777', '5 - groceries');
      expect(unlinked.ok).toBe(false);

      await linkChat();
      await request(http)
        .delete('/telegram/link')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      const settings = await request(http)
        .get('/telegram/settings')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(settings.body).toMatchObject({ linked: false });
    });
  });

  describe('imports & categorization', () => {
    let accountId: string;

    const MAPPING = {
      dateColumn: 'Date',
      amountColumn: 'Amount',
      descriptionColumn: 'Description',
      dateFormat: 'ISO',
      decimalSeparator: '.',
      negativeIsExpense: true,
      hasHeader: true,
    };

    // The fingerprint includes the description, so a charge the user typed in
    // themselves — in their own words, and with no fingerprint at all — is
    // invisible to it. This is the second, weaker check that notices anyway.
    describe('possible duplicates of existing transactions', () => {
      type Row = { description: string; status: string; note: string | null };
      const rowsOf = (res: { body: unknown }) =>
        (res.body as { batch: { rows: Row[] } }).batch.rows;

      const addManual = async (description: string, amount = 1911) => {
        const sub = await createSubcategory(`Typed ${description}`, 'Expenses');
        return request(http)
          .post('/transactions')
          .set('Authorization', `Bearer ${token}`)
          .send({
            type: 'EXPENSE',
            date: '2026-08-12',
            amount,
            description,
            subcategoryId: sub.id,
            accountId,
          })
          .expect(201);
      };

      const importOne = (description: string, amount = '-19.11') =>
        importAndWait(token, {
          accountId,
          filename: 'x.csv',
          csv: `Date,Amount,Description\n2026-08-12,${amount},${description}`,
          mapping: MAPPING,
        });

      it('notes a charge already entered by hand under a different name', async () => {
        await addManual('Open code monthly subscription');
        const rows = rowsOf(await importOne('Anomaly'));
        expect(rows).toHaveLength(1);
        expect(rows[0].status).not.toBe('DUPLICATE');
        expect(rows[0].note).toContain('Possible duplicate');
        // The description is the part that cannot be recovered otherwise.
        expect(rows[0].note).toContain('Open code monthly subscription');
      });

      it('says nothing when the day, amount or direction differ', async () => {
        await addManual('Open code monthly subscription');
        expect(rowsOf(await importOne('Anomaly', '-19.12'))[0].note).toBeNull();
        expect(
          rowsOf(
            await importAndWait(token, {
              accountId,
              filename: 'y.csv',
              csv: 'Date,Amount,Description\n2026-08-13,-19.11,Anomaly',
              mapping: MAPPING,
            }),
          )[0].note,
        ).toBeNull();
        // Same amount and day, but money coming in rather than going out.
        expect(
          rowsOf(
            await importAndWait(token, {
              accountId,
              filename: 'z.csv',
              csv: 'Date,Amount,Description\n2026-08-12,19.11,Anomaly',
              mapping: MAPPING,
            }),
          )[0].note,
        ).toBeNull();
      });

      // Same wording is caught by the fingerprint, which excludes it outright;
      // the weaker note would be redundant and must not overwrite that.
      it('leaves an exact re-import as a plain duplicate', async () => {
        await importOne('Anomaly');
        const batch = await importOne('Anomaly');
        const committed = rowsOf(batch)[0];
        expect(committed.status).toBe('NEEDS_REVIEW');
        expect(committed.note).toBeNull();
      });
    });

    // A bank that reports the fee in its own column (Revolut's "Fee"). The fee
    // is real spending that used to be dropped with the other unmapped columns.
    describe('fee column', () => {
      const FEE_MAPPING = { ...MAPPING, feeColumn: 'Fee' };
      type Row = {
        description: string;
        amount: number;
        type: string;
        status: string;
      };
      const rowsOf = (res: { body: unknown }) =>
        (res.body as { batch: { rows: Row[] } }).batch.rows;

      it('stages a fee as its own expense beside the charge', async () => {
        const res = await importAndWait(token, {
          accountId,
          filename: 'fees.csv',
          csv: [
            'Date,Amount,Description,Fee',
            '2026-07-01,-42.93,Lacher Patisserie,0.43',
          ].join('\n'),
          mapping: FEE_MAPPING,
        });
        expect(rowsOf(res)).toEqual([
          expect.objectContaining({
            description: 'Lacher Patisserie',
            amount: 4293,
            type: 'EXPENSE',
          }),
          expect.objectContaining({
            description: 'Fee · Lacher Patisserie',
            amount: 43,
            type: 'EXPENSE',
          }),
        ]);
      });

      // A fee carries the charge's own description, and rule patterns match on
      // substring, so a transfer rule learned from "To Kamila Jusupova" also
      // matches "Fee · To Kamila Jusupova". Committing that as a transfer
      // would credit the counter account with money that only ever went to
      // the bank — and a rule hit is marked READY, so it would never stop at
      // the review screen to be noticed.
      it('never lets a transfer rule claim the fee taken on that transfer', async () => {
        const other = (await createAccount(0)).id;
        await request(http)
          .post('/rules')
          .set('Authorization', `Bearer ${token}`)
          .send({ pattern: 'to kamila jusupova', counterAccountId: other })
          .expect(201);

        const res = await importAndWait(token, {
          accountId,
          filename: 'transfer-fee.csv',
          csv: [
            'Date,Amount,Description,Fee',
            '2026-07-03,-500.00,To Kamila Jusupova,3.50',
          ].join('\n'),
          mapping: FEE_MAPPING,
        });

        const rows = (
          res.body as {
            batch: {
              rows: (Row & { counterAccount: unknown; subcategory: unknown })[];
            };
          }
        ).batch.rows;
        const charge = rows.find((r) => r.description === 'To Kamila Jusupova');
        const fee = rows.find(
          (r) => r.description === 'Fee · To Kamila Jusupova',
        );

        // The charge is the transfer the rule was taught about.
        expect(charge?.counterAccount).toBeTruthy();
        // The fee is not, and did not quietly take the rule's word for it.
        expect(fee).toBeDefined();
        expect(fee?.counterAccount).toBeFalsy();
        expect(fee?.amount).toBe(350);
        expect(fee?.type).toBe('EXPENSE');
      });

      // The case that is invisible without this: the whole cost is the fee, so
      // the charge itself is zero and the line was skipped outright.
      it('keeps the fee when the charge itself is zero', async () => {
        const res = await importAndWait(token, {
          accountId,
          filename: 'metal.csv',
          csv: [
            'Date,Amount,Description,Fee',
            '2026-07-02,0.00,Metal plan fee,15.99',
          ].join('\n'),
          mapping: FEE_MAPPING,
        });
        expect(rowsOf(res)).toEqual([
          expect.objectContaining({
            description: 'Fee · Metal plan fee',
            amount: 1599,
            type: 'EXPENSE',
          }),
        ]);
        expect((res.body as { skipped: { reason: string }[] }).skipped).toEqual(
          [
            expect.objectContaining({
              reason: 'zero amount — its fee was imported on its own',
            }),
          ],
        );
      });

      // A fee is money out even when the line it sits on is money in.
      it('books a fee on an income line as an expense', async () => {
        const res = await importAndWait(token, {
          accountId,
          filename: 'in.csv',
          csv: [
            'Date,Amount,Description,Fee',
            '2026-07-03,500.00,Incoming transfer,18.00',
          ].join('\n'),
          mapping: FEE_MAPPING,
        });
        expect(rowsOf(res)).toEqual([
          expect.objectContaining({ type: 'INCOME', amount: 50000 }),
          expect.objectContaining({ type: 'EXPENSE', amount: 1800 }),
        ]);
      });

      it('ignores a zero fee, and any fee at all without the mapping', async () => {
        const csv = [
          'Date,Amount,Description,Fee',
          '2026-07-04,-10.00,No fee here,0.00',
          '2026-07-05,-20.00,Has a fee,1.50',
        ].join('\n');
        const mapped = await importAndWait(token, {
          accountId,
          filename: 'mixed.csv',
          csv,
          mapping: FEE_MAPPING,
        });
        expect(rowsOf(mapped)).toHaveLength(3); // two charges + one fee

        const unmapped = await importAndWait(token, {
          accountId,
          filename: 'unmapped.csv',
          csv,
          mapping: MAPPING,
        });
        expect(rowsOf(unmapped)).toHaveLength(2);
      });

      it('rejects a fee column that is not in the file', async () => {
        const res = await importAndWait(token, {
          accountId,
          filename: 'bad.csv',
          csv: 'Date,Amount,Description\n2026-07-06,-1.00,x',
          mapping: { ...MAPPING, feeColumn: 'Charges' },
        });
        expect(res.status).toBe(400);
      });
    });

    // Rent + Salary name-match the seeded subcategories; the shop does not.
    const CSV = [
      'Date,Amount,Description',
      '2026-07-01,-12.50,SPAR AMSTERDAM 4471',
      '2026-07-02,-800.00,Monthly Rent',
      '2026-07-03,2000.00,Salary payment ACME',
    ].join('\n');

    type Row = {
      id: string;
      status: string;
      source: string;
      description: string;
      subcategory: { name: string } | null;
      excludeFromStats: boolean;
    };
    type Batch = { id: string; status: string; rows: Row[] };

    beforeEach(async () => {
      accountId = (await createAccount(500_000)).id;
    });

    const subId = async (name: string): Promise<string> => {
      const res = await request(http)
        .get('/subcategories')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      const found = (res.body as { id: string; name: string }[]).find(
        (s) => s.name === name,
      );
      if (!found) throw new Error(`subcategory ${name} not found`);
      return found.id;
    };

    /**
     * A transfer rule stores a description pattern and a counter account, and
     * nothing else — no currency, no source account. So one taught on a euro
     * account matches a tenge statement on description alone, and committing
     * that wrote the statement's own number into the other account at face
     * value: 540 KZT arriving as 540 EUR. The manual path has refused a
     * cross-currency transfer since the beginning; the rule path never asked.
     *
     * Both directions are pinned here, because a guard that blocks everything
     * would pass a test that only checks the bad case.
     */
    it('applies a transfer rule only when both accounts share a currency', async () => {
      const sameCurrency = (
        await createAccount(0, token, { name: 'EUR Savings' })
      ).id;
      const otherCurrency = (
        await createAccount(0, token, { name: 'Kaspi', currency: 'KZT' })
      ).id;

      await request(http)
        .post('/rules')
        .set('Authorization', `Bearer ${token}`)
        .send({ pattern: 'to savings', counterAccountId: sameCurrency })
        .expect(201);
      await request(http)
        .post('/rules')
        .set('Authorization', `Bearer ${token}`)
        .send({ pattern: 'to kaspi', counterAccountId: otherCurrency })
        .expect(201);

      const batch = await doImport(
        [
          'Date,Amount,Description',
          '2026-07-05,-100.00,Move to savings',
          '2026-07-06,-200.00,Move to kaspi',
        ].join('\n'),
      );

      const rows = batch.rows as unknown as {
        description: string;
        counterAccount: { id: string } | null;
      }[];
      const toSavings = rows.find((r) => r.description.includes('savings'));
      const toKaspi = rows.find((r) => r.description.includes('kaspi'));

      // Same currency: the rule does its job.
      expect(toSavings?.counterAccount?.id).toBe(sameCurrency);
      // Different currency: no transfer is posted. The row is still a real
      // charge, so it goes to the categorizer rather than being dropped.
      expect(toKaspi?.counterAccount).toBeNull();
    });

    // Two charges from one merchant on one day, honestly belonging to different
    // categories (IKEA curtains vs IKEA meatballs). Recategorising the second
    // must not repoint the learned "ikea" rule for every future import.
    it('a correction that disagrees with a rule does not repoint the rule', async () => {
      const shopping = await subId('Shopping');
      const groceries = await subId('Groceries');

      // Teach the rule explicitly, the way the Rules page would.
      await request(http)
        .post('/rules')
        .set('Authorization', `Bearer ${token}`)
        .send({ pattern: 'ikea', subcategoryId: shopping })
        .expect(201);

      const batch = await doImport(
        [
          'Date,Amount,Description',
          '2026-07-04,-167.85,Ikea',
          '2026-07-04,-13.45,Ikea',
        ].join('\n'),
      );
      // Both rows arrive categorised by the rule.
      expect(batch.rows.every((r) => r.subcategory?.name === 'Shopping')).toBe(
        true,
      );

      // The user corrects one of them to Groceries, then commits.
      await request(http)
        .patch(`/imports/${batch.id}/rows/${batch.rows[1].id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ subcategoryId: groceries })
        .expect(200);
      await request(http)
        .post(`/imports/${batch.id}/commit`)
        .set('Authorization', `Bearer ${token}`)
        .expect(201);

      const rules = await request(http)
        .get('/rules')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      const ikea = (
        rules.body as {
          pattern: string;
          subcategory: { name: string } | null;
        }[]
      ).filter((r) => r.pattern === 'ikea');
      expect(ikea).toHaveLength(1);
      // Still Shopping. The one-off correction applied to its own row only.
      expect(ikea[0].subcategory?.name).toBe('Shopping');
    });

    // The refinement case, which a blanket "a rule fired, so learn nothing"
    // guard used to kill: the correction teaches a longer pattern, which wins
    // longest-match, and the broad rule survives untouched.
    it('learns a more specific rule when the correction is not the same pattern', async () => {
      const shopping = await subId('Shopping');
      // A Subscriptions entry the seed already provides; looked up like the rest.
      const subs = { id: await subId('Streaming') };
      await request(http)
        .post('/rules')
        .set('Authorization', `Bearer ${token}`)
        .send({ pattern: 'amazon', subcategoryId: shopping })
        .expect(201);

      const batch = await doImport(
        ['Date,Amount,Description', '2026-07-04,-9.99,AMAZON PRIME VIDEO'].join(
          '\n',
        ),
      );
      await request(http)
        .patch(`/imports/${batch.id}/rows/${batch.rows[0].id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ subcategoryId: subs.id })
        .expect(200);
      await request(http)
        .post(`/imports/${batch.id}/commit`)
        .set('Authorization', `Bearer ${token}`)
        .expect(201);

      const rules = await request(http)
        .get('/rules')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      const all = rules.body as {
        pattern: string;
        subcategory: { name: string } | null;
      }[];
      // The broad rule is untouched...
      expect(all.find((r) => r.pattern === 'amazon')?.subcategory?.name).toBe(
        'Shopping',
      );
      // ...and the specific one was learned.
      expect(
        all.find((r) => r.pattern === 'amazon prime video')?.subcategory?.name,
      ).toBe('Streaming');
    });

    // Same merchant, two categories, one batch. Nothing can say which is the
    // rule, so the upsert must not silently keep whichever row came last.
    it('learns nothing when one merchant is corrected two different ways', async () => {
      const groceries = await subId('Groceries');
      const shopping = await subId('Shopping');
      const batch = await doImport(
        [
          'Date,Amount,Description',
          '2026-07-04,-167.85,Ikea',
          '2026-07-04,-13.45,Ikea',
        ].join('\n'),
      );
      await request(http)
        .patch(`/imports/${batch.id}/rows/${batch.rows[0].id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ subcategoryId: shopping })
        .expect(200);
      await request(http)
        .patch(`/imports/${batch.id}/rows/${batch.rows[1].id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ subcategoryId: groceries })
        .expect(200);
      await request(http)
        .post(`/imports/${batch.id}/commit`)
        .set('Authorization', `Bearer ${token}`)
        .expect(201);

      const rules = await request(http)
        .get('/rules')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(
        (rules.body as { pattern: string }[]).filter(
          (r) => r.pattern === 'ikea',
        ),
      ).toHaveLength(0);
    });

    // 23 rows in the live database sat at COMMITTED with no transaction: the
    // FK nulls the link on delete, but nothing reset the status, so the batch
    // went on claiming rows that were no longer in the ledger — and undo(),
    // which only looks at rows still holding a transactionId, could not reach
    // them to put it right.
    it('releases an import row when its transaction is deleted', async () => {
      const batch = await doImport();
      await request(http)
        .post(`/imports/${batch.id}/commit`)
        .set('Authorization', `Bearer ${token}`)
        .expect(201);

      const committed = await request(http)
        .get(`/imports/${batch.id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      const row = (
        committed.body as {
          rows: { id: string; status: string; transactionId: string | null }[];
        }
      ).rows.find((r) => r.status === 'COMMITTED' && r.transactionId);
      expect(row).toBeDefined();

      await request(http)
        .delete(`/transactions/${row!.transactionId as string}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const after = await request(http)
        .get(`/imports/${batch.id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      const same = (
        after.body as {
          rows: { id: string; status: string; transactionId: string | null }[];
        }
      ).rows.find((r) => r.id === row!.id);
      expect(same?.transactionId).toBeNull();
      expect(same?.status).toBe('SKIPPED');
    });

    // The single-delete fix was made without checking the other two delete
    // paths, and they had the same defect — this covers all three so the next
    // one cannot be missed either.
    it.each([
      [
        'bulk delete',
        (ids: string[]) =>
          request(http)
            .post('/transactions/bulk-delete')
            .set('Authorization', `Bearer ${token}`)
            .send({ ids })
            .expect(201),
      ],
      [
        'delete all',
        () =>
          request(http)
            .delete('/transactions')
            .set('Authorization', `Bearer ${token}`)
            .expect(200),
      ],
    ])('releases an import row through %s too', async (_name, remove) => {
      const batch = await doImport();
      await request(http)
        .post(`/imports/${batch.id}/commit`)
        .set('Authorization', `Bearer ${token}`)
        .expect(201);

      const rowsOf = async () =>
        (
          await request(http)
            .get(`/imports/${batch.id}`)
            .set('Authorization', `Bearer ${token}`)
            .expect(200)
        ).body as {
          rows: { id: string; status: string; transactionId: string | null }[];
        };

      const committed = (await rowsOf()).rows.filter(
        (r) => r.status === 'COMMITTED' && r.transactionId,
      );
      expect(committed.length).toBeGreaterThan(0);

      await remove(committed.map((r) => r.transactionId as string));

      const after = (await rowsOf()).rows.filter((r) =>
        committed.some((c) => c.id === r.id),
      );
      // None still claim a transaction that no longer exists.
      expect(after.every((r) => r.transactionId === null)).toBe(true);
      expect(after.every((r) => r.status === 'SKIPPED')).toBe(true);
    });

    it('records what ran the import and how long it took', async () => {
      const batch = await doImport();
      await request(http)
        .post(`/imports/${batch.id}/commit`)
        .set('Authorization', `Bearer ${token}`)
        .expect(201);

      const res = await request(http)
        .get('/imports/stats/accuracy')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      const stats = res.body as {
        byBatch: {
          provider: string;
          model: string | null;
          categorizeMs: number | null;
          extractMs: number | null;
          rows: number;
        }[];
      };
      const mine = stats.byBatch[stats.byBatch.length - 1];
      expect(mine.provider).toBe('heuristic');
      // Timed, not merely present: a zero would mean the clock never ran.
      expect(mine.categorizeMs).toBeGreaterThanOrEqual(0);
      expect(mine.categorizeMs).not.toBeNull();
      // CSV needs no extraction, so that stays null and the two are separable.
      expect(mine.extractMs).toBeNull();
      expect(mine.rows).toBeGreaterThan(0);
    });

    // The measurement this exists for happens before committing: committing a
    // run makes the next run of the same file all duplicates and teaches rules
    // from the corrections, so a second model would be scored on a statement
    // the first had already taught.
    it('measures a run that has not been committed', async () => {
      const groceries = await subId('Groceries');
      const batch = await doImport();
      // Correcting a row is what writes the ground truth, and it happens here,
      // not at commit.
      await request(http)
        .patch(`/imports/${batch.id}/rows/${batch.rows[0].id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ subcategoryId: groceries })
        .expect(200);

      const res = await request(http)
        .get(`/imports/${batch.id}/benchmark`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      const b = res.body as {
        status: string;
        provider: string;
        categorizeMs: number | null;
        msPerModelRow: number | null;
        rows: {
          total: number;
          duplicates: number;
          offered: number;
          matchedByRule: number;
          sentToModel: number;
        };
        coverage: { answered: number; abstained: number; rate: number | null };
        accuracy: { kept: number; changed: number; rate: number | null };
      };

      expect(b.status).toBe('PENDING_REVIEW');
      expect(b.provider).toBe('heuristic');
      // Timed, not merely present.
      expect(b.categorizeMs).not.toBeNull();
      expect(b.msPerModelRow).not.toBeNull();
      // The parts of the file account for the whole of it.
      expect(b.rows.offered).toBe(b.rows.total - b.rows.duplicates);
      expect(b.rows.sentToModel).toBe(b.rows.offered - b.rows.matchedByRule);
      // Coverage splits what was asked, exactly.
      expect(b.coverage.answered + b.coverage.abstained).toBe(
        b.rows.sentToModel,
      );
      // The corrected row is counted against the prediction, not ignored.
      expect(b.accuracy.kept + b.accuracy.changed).toBe(b.coverage.answered);
    });

    it('offers the categorizers this server can actually run', async () => {
      const res = await request(http)
        .get('/imports/categorizers')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      const options = res.body as {
        id: string;
        available: boolean;
        isDefault: boolean;
        sendsDataOffServer: boolean;
      }[];
      expect(options.map((o) => o.id).sort()).toEqual([
        'anthropic',
        'heuristic',
        'ollama',
      ]);
      // Tests run with no API key, so Claude is listed but not offerable, and
      // the only provider that would send data off the server is the one that
      // cannot run.
      const claude = options.find((o) => o.id === 'anthropic');
      expect(claude).toMatchObject({
        available: false,
        isDefault: false,
        sendsDataOffServer: true,
      });
      expect(options.filter((o) => o.isDefault)).toHaveLength(1);
    });

    it('rejects an import asking for a provider this server cannot run', async () => {
      expect(
        (
          await importAndWait(token, {
            accountId,
            filename: 'statement.csv',
            csv: CSV,
            mapping: MAPPING,
            categorizer: 'anthropic',
          })
        ).status,
      ).toBe(400);
    });

    it('records the categorizer an import asked for, not the default', async () => {
      const created = await importAndWait(token, {
        accountId,
        filename: 'statement.csv',
        csv: CSV,
        mapping: MAPPING,
        categorizer: 'heuristic',
      });
      expect(created.status).toBe(201);
      const batchId = (created.body as { batch: { id: string } }).batch.id;
      // Accuracy is only measured over committed rows, so the batch has to
      // land before it shows up in the stats at all.
      await request(http)
        .post(`/imports/${batchId}/commit`)
        .set('Authorization', `Bearer ${token}`)
        .expect(201);

      const res = await request(http)
        .get('/imports/stats/accuracy')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      // Looked up by id: byBatch is built from a map of rows, so its order is
      // not batch order and "the last one" is not this one.
      const stats = res.body as {
        byBatch: { batchId: string; provider: string }[];
      };
      expect(stats.byBatch.find((b) => b.batchId === batchId)?.provider).toBe(
        'heuristic',
      );
    });

    it('counts a rule as used only for rows the user kept', async () => {
      const shopping = await subId('Shopping');
      const groceries = await subId('Groceries');
      await request(http)
        .post('/rules')
        .set('Authorization', `Bearer ${token}`)
        .send({ pattern: 'ikea', subcategoryId: shopping })
        .expect(201);

      const batch = await doImport(
        [
          'Date,Amount,Description',
          '2026-07-04,-10.00,Ikea',
          '2026-07-05,-20.00,Ikea',
          '2026-07-06,-30.00,Ikea',
        ].join('\n'),
      );
      // One of the three is corrected away from the rule.
      await request(http)
        .patch(`/imports/${batch.id}/rows/${batch.rows[2].id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ subcategoryId: groceries })
        .expect(200);
      await request(http)
        .post(`/imports/${batch.id}/commit`)
        .set('Authorization', `Bearer ${token}`)
        .expect(201);

      const rules = await request(http)
        .get('/rules')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      const ikea = (rules.body as { pattern: string; hitCount: number }[]).find(
        (r) => r.pattern === 'ikea',
      );
      // Two kept, one corrected. A rule that fired and was overruled did its
      // job badly, so counting it would make a bad rule look well used.
      expect(ikea?.hitCount).toBe(2);
    });

    const hitCountFor = async (pattern: string): Promise<number> => {
      const res = await request(http)
        .get('/rules')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      const found = (res.body as { pattern: string; hitCount: number }[]).find(
        (r) => r.pattern === pattern,
      );
      if (!found) throw new Error(`rule ${pattern} not found`);
      return found.hitCount;
    };

    it('counts a transfer rule the same as a subcategory one', async () => {
      const other = await createAccount(0);
      await request(http)
        .post('/rules')
        .set('Authorization', `Bearer ${token}`)
        .send({ pattern: 'to savings', counterAccountId: other.id })
        .expect(201);

      const batch = await doImport(
        [
          'Date,Amount,Description',
          '2026-07-04,-10.00,To savings',
          '2026-07-05,-20.00,To savings',
        ].join('\n'),
      );
      await request(http)
        .post(`/imports/${batch.id}/commit`)
        .set('Authorization', `Bearer ${token}`)
        .expect(201);

      expect(await hitCountFor('to savings')).toBe(2);
    });

    it('counts a row the user re-confirmed at the rule s own suggestion', async () => {
      const shopping = await subId('Shopping');
      await request(http)
        .post('/rules')
        .set('Authorization', `Bearer ${token}`)
        .send({ pattern: 'ikea', subcategoryId: shopping })
        .expect(201);

      const batch = await doImport(
        ['Date,Amount,Description', '2026-07-04,-10.00,Ikea'].join('\n'),
      );
      // Clicking "confirm" on a row that already carries the rule's answer is
      // agreement, not a correction, so the rule still did the work.
      await request(http)
        .patch(`/imports/${batch.id}/rows/${batch.rows[0].id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ subcategoryId: shopping })
        .expect(200);
      await request(http)
        .post(`/imports/${batch.id}/commit`)
        .set('Authorization', `Bearer ${token}`)
        .expect(201);

      expect(await hitCountFor('ikea')).toBe(1);
    });

    // Flipping a row's direction invalidates the rule that matched it: that rule
    // was for the other sign. Leaving its id on the row let undo take usage off
    // a rule the row never credited, and made commit treat the row as
    // "overruling the rule that fired", which silently skipped learning.
    it('drops the matched rule when a row is flipped', async () => {
      const shopping = await subId('Shopping');
      const refunds = await subId('Groceries');
      await request(http)
        .post('/rules')
        .set('Authorization', `Bearer ${token}`)
        .send({ pattern: 'ikea', subcategoryId: shopping })
        .expect(201);

      const batch = await doImport(
        [
          'Date,Amount,Description',
          '2026-07-04,-10.00,Ikea',
          '2026-07-05,-20.00,Ikea',
        ].join('\n'),
      );
      await request(http)
        .post(`/imports/${batch.id}/rows/${batch.rows[1].id}/flip`)
        .set('Authorization', `Bearer ${token}`)
        .expect(201);
      await request(http)
        .patch(`/imports/${batch.id}/rows/${batch.rows[1].id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ subcategoryId: refunds })
        .expect(200);
      await request(http)
        .post(`/imports/${batch.id}/commit`)
        .set('Authorization', `Bearer ${token}`)
        .expect(201);

      // Only the unflipped row was the rule's work.
      expect(await hitCountFor('ikea')).toBe(1);
      // The flipped row's correction taught its own rule, on the other sign.
      const rules = await request(http)
        .get('/rules')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      const learned = (
        rules.body as { pattern: string; type: string; hitCount: number }[]
      ).filter((r) => r.pattern === 'ikea');
      expect(learned.map((r) => r.type).sort()).toEqual(['EXPENSE', 'INCOME']);

      // And undo takes back exactly what commit credited, never more.
      await request(http)
        .post(`/imports/${batch.id}/undo`)
        .set('Authorization', `Bearer ${token}`)
        .expect(201);
      expect(await hitCountFor('ikea')).toBe(0);
    });

    it('gives usage back on undo, and does not double count on re-commit', async () => {
      const shopping = await subId('Shopping');
      await request(http)
        .post('/rules')
        .set('Authorization', `Bearer ${token}`)
        .send({ pattern: 'ikea', subcategoryId: shopping })
        .expect(201);

      const batch = await doImport(
        [
          'Date,Amount,Description',
          '2026-07-04,-10.00,Ikea',
          '2026-07-05,-20.00,Ikea',
        ].join('\n'),
      );
      await request(http)
        .post(`/imports/${batch.id}/commit`)
        .set('Authorization', `Bearer ${token}`)
        .expect(201);
      expect(await hitCountFor('ikea')).toBe(2);

      await request(http)
        .post(`/imports/${batch.id}/undo`)
        .set('Authorization', `Bearer ${token}`)
        .expect(201);
      expect(await hitCountFor('ikea')).toBe(0);

      // Undo parks the batch in UNDONE, which no longer opens for commit.
      await request(http)
        .post(`/imports/${batch.id}/reopen`)
        .set('Authorization', `Bearer ${token}`)
        .expect(201);
      await request(http)
        .post(`/imports/${batch.id}/commit`)
        .set('Authorization', `Bearer ${token}`)
        .expect(201);
      expect(await hitCountFor('ikea')).toBe(2);
    });

    const doImport = async (csv = CSV, withMapping = true): Promise<Batch> => {
      const res = await importAndWait(token, {
        accountId,
        filename: 'statement.csv',
        csv,
        ...(withMapping ? { mapping: MAPPING } : {}),
      });
      expect(res.status).toBe(201);
      return (res.body as { batch: Batch }).batch;
    };

    const rowFor = (batch: Batch, needle: string): Row => {
      const row = batch.rows.find((r) => r.description.includes(needle));
      if (!row) throw new Error(`row ${needle} not found`);
      return row;
    };

    it('inspects a CSV, returning headers and a sample', async () => {
      const res = await request(http)
        .post('/imports/inspect')
        .set('Authorization', `Bearer ${token}`)
        .send({ csv: CSV })
        .expect(201);
      expect(res.body).toMatchObject({
        headers: ['Date', 'Amount', 'Description'],
      });
      expect((res.body as { sample: unknown[] }).sample).toHaveLength(3);
    });

    it('stages rows, name-matches known categories, flags unknowns for review', async () => {
      const batch = await doImport();
      expect(batch.rows).toHaveLength(3);

      expect(rowFor(batch, 'Rent')).toMatchObject({
        status: 'READY',
        subcategory: { name: 'Rent' },
      });
      expect(rowFor(batch, 'Salary')).toMatchObject({
        status: 'READY',
        subcategory: { name: 'Salary' },
      });
      // No brand dictionary: an unknown shop is left for the human.
      expect(rowFor(batch, 'SPAR')).toMatchObject({
        status: 'NEEDS_REVIEW',
        subcategory: null,
      });
    });

    it('skips an amount too large for the integer column instead of erroring', async () => {
      // A dot-decimal file read as comma turns 30000000.00 into 3,000,000,000
      // cents, past the 32-bit column. It must skip that row with a hint, not
      // 500, and still import the valid rows.
      const res = await importAndWait(token, {
        accountId,
        filename: 'huge.csv',
        csv: [
          'Date,Amount,Description',
          '2026-07-01,-30000000.00,Overflow Co',
          '2026-07-02,-12.50,SPAR AMSTERDAM 4471',
        ].join('\n'),
        mapping: MAPPING,
      });
      expect(res.status).toBe(201);
      const body = res.body as {
        batch: Batch;
        skipped: { reason: string }[];
      };
      expect(body.skipped).toEqual([
        expect.objectContaining({
          reason: expect.stringContaining('out of range'),
        }),
      ]);
      expect(body.batch.rows).toHaveLength(1);
      expect(body.batch.rows[0].description).toContain('SPAR');
    });

    it('marks a row internal: commits it, excludes it from stats, and auto-tags repeats', async () => {
      const csv = [
        'Date,Amount,Description',
        '2026-07-01,100.00,Receipt from your account From Kaspi Pay',
      ].join('\n');
      const batch = await doImport(csv);
      const row = batch.rows[0];
      expect(row.status).toBe('NEEDS_REVIEW');

      await request(http)
        .patch(`/imports/${batch.id}/rows/${row.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ excludeFromStats: true })
        .expect(200);
      await request(http)
        .post(`/imports/${batch.id}/commit`)
        .set('Authorization', `Bearer ${token}`)
        .expect(201);

      // It moved the balance (income +100 on a 500000-cent account) ...
      expect(await getBalance(accountId)).toBe(510_000);
      // ... but is not counted as income.
      const stats = await request(http)
        .get('/transactions/stats')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(stats.body).toMatchObject({ monthly: [], incomeByCategory: [] });

      // A learned rule auto-flags the same counterparty on a later import.
      const next = await doImport(
        [
          'Date,Amount,Description',
          '2026-08-01,250.00,Receipt from your account From Kaspi Pay',
        ].join('\n'),
      );
      expect(next.rows[0]).toMatchObject({
        status: 'READY',
        source: 'RULE',
        excludeFromStats: true,
      });
    });

    it('commits only resolved rows, creates transactions and moves the balance', async () => {
      const batch = await doImport();
      // Leave SPAR unreviewed: only the two READY rows should commit.
      await request(http)
        .post(`/imports/${batch.id}/commit`)
        .set('Authorization', `Bearer ${token}`)
        .expect(201);

      // 500000 + 200000 (salary) − 80000 (rent) = 620000
      expect(await getBalance(accountId)).toBe(620_000);
      const txns = await request(http)
        .get('/transactions')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(txns.body).toMatchObject({ total: 2 });
    });

    it('learns a rule from a correction and reuses it on later imports', async () => {
      const batch = await doImport();
      const spar = rowFor(batch, 'SPAR');
      const groceriesId = await subId('Groceries');

      await request(http)
        .patch(`/imports/${batch.id}/rows/${spar.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ subcategoryId: groceriesId })
        .expect(200);
      await request(http)
        .post(`/imports/${batch.id}/commit`)
        .set('Authorization', `Bearer ${token}`)
        .expect(201);

      // The correction is stored as a rule.
      const rules = await request(http)
        .get('/rules')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(rules.body).toEqual([
        expect.objectContaining({ pattern: 'spar amsterdam' }),
      ]);

      // A later, non-duplicate SPAR purchase is now auto-categorized by the rule.
      const next = await doImport(
        'Date,Amount,Description\n2026-08-09,-9.00,SPAR AMSTERDAM 8899',
      );
      expect(rowFor(next, 'SPAR')).toMatchObject({
        status: 'READY',
        source: 'RULE',
        subcategory: { name: 'Groceries' },
      });
    });

    it('detects duplicates when the same statement is re-imported', async () => {
      const first = await doImport();
      // Review the unknown row so all three commit (dedupe is vs committed rows).
      await request(http)
        .patch(`/imports/${first.id}/rows/${rowFor(first, 'SPAR').id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ subcategoryId: await subId('Groceries') })
        .expect(200);
      await request(http)
        .post(`/imports/${first.id}/commit`)
        .set('Authorization', `Bearer ${token}`)
        .expect(201);
      const balanceAfterFirst = await getBalance(accountId);

      const second = await doImport();
      expect(second.rows.every((r) => r.status === 'DUPLICATE')).toBe(true);

      // A duplicate cannot be reviewed into inclusion (no double-counting).
      await request(http)
        .patch(`/imports/${second.id}/rows/${second.rows[0].id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ subcategoryId: await subId('Groceries') })
        .expect(409);

      await request(http)
        .post(`/imports/${second.id}/commit`)
        .set('Authorization', `Bearer ${token}`)
        .expect(201);
      expect(await getBalance(accountId)).toBe(balanceAfterFirst);
    });

    it('force-includes a duplicate via "import anyway"', async () => {
      const first = await doImport();
      await request(http)
        .patch(`/imports/${first.id}/rows/${rowFor(first, 'SPAR').id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ subcategoryId: await subId('Groceries') })
        .expect(200);
      await request(http)
        .post(`/imports/${first.id}/commit`)
        .set('Authorization', `Bearer ${token}`)
        .expect(201);
      const balanceAfterFirst = await getBalance(accountId);

      // Re-import: the SPAR row is flagged DUPLICATE. Override it, categorize,
      // and commit — it posts a second time (the −12.50 charge repeats).
      const second = await doImport();
      const dup = rowFor(second, 'SPAR');
      expect(dup.status).toBe('DUPLICATE');

      // reviewRow still refuses a raw duplicate; the override route is the path in.
      await request(http)
        .patch(`/imports/${second.id}/rows/${dup.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ subcategoryId: await subId('Groceries') })
        .expect(409);

      await request(http)
        .post(`/imports/${second.id}/rows/${dup.id}/include`)
        .set('Authorization', `Bearer ${token}`)
        .expect(201);
      await request(http)
        .patch(`/imports/${second.id}/rows/${dup.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ subcategoryId: await subId('Groceries') })
        .expect(200);
      await request(http)
        .post(`/imports/${second.id}/commit`)
        .set('Authorization', `Bearer ${token}`)
        .expect(201);

      // The overridden SPAR (−12.50 = 1250 cents) committed despite the match.
      expect(await getBalance(accountId)).toBe(balanceAfterFirst - 1250);
    });

    it('flips a row between income and expense and resets it to review', async () => {
      const batch = await doImport();
      const rent = rowFor(batch, 'Rent'); // −800 → EXPENSE, matched to Rent
      const flipped = await request(http)
        .post(`/imports/${batch.id}/rows/${rent.id}/flip`)
        .set('Authorization', `Bearer ${token}`)
        .expect(201);
      // Now income, and its old category is cleared so it must be re-reviewed.
      expect(flipped.body).toMatchObject({
        type: 'INCOME',
        status: 'NEEDS_REVIEW',
        subcategory: null,
      });
    });

    it('dedupes a transfer recorded from both accounts on the same date', async () => {
      const other = await createAccount(0);
      // Account A's statement: €100 out to the other account on the 10th.
      const a = await doImport(
        ['Date,Amount,Description', '2026-07-10,-100.00,To savings'].join('\n'),
      );
      await request(http)
        .patch(`/imports/${a.id}/rows/${a.rows[0].id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ counterAccountId: other.id })
        .expect(200);
      await request(http)
        .post(`/imports/${a.id}/commit`)
        .set('Authorization', `Bearer ${token}`)
        .expect(201);
      expect(await getBalance(accountId)).toBe(490_000);
      expect(await getBalance(other.id)).toBe(10_000);

      // The other account's statement shows the same €100 arriving, dated the
      // same day. (The ±day window was removed, so the mirror match is exact.)
      const bRes = await importAndWait(token, {
        accountId: other.id,
        filename: 'b.csv',
        csv: [
          'Date,Amount,Description',
          '2026-07-10,100.00,From checking',
        ].join('\n'),
        mapping: MAPPING,
      });
      expect(bRes.status).toBe(201);
      const bBatch = (
        bRes.body as { batch: { id: string; rows: { id: string }[] } }
      ).batch;
      await request(http)
        .patch(`/imports/${bBatch.id}/rows/${bBatch.rows[0].id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ counterAccountId: accountId })
        .expect(200);
      await request(http)
        .post(`/imports/${bBatch.id}/commit`)
        .set('Authorization', `Bearer ${token}`)
        .expect(201);

      // Recognized as the same movement — balances unchanged, not double-counted.
      expect(await getBalance(accountId)).toBe(490_000);
      expect(await getBalance(other.id)).toBe(10_000);
    });

    it('warns (does not silently merge) when a transfer leg lands a few days apart', async () => {
      const other = await createAccount(0);
      const a = await doImport(
        ['Date,Amount,Description', '2026-07-10,-100.00,To savings'].join('\n'),
      );
      await request(http)
        .patch(`/imports/${a.id}/rows/${a.rows[0].id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ counterAccountId: other.id })
        .expect(200);
      await request(http)
        .post(`/imports/${a.id}/commit`)
        .set('Authorization', `Bearer ${token}`)
        .expect(201);

      // The other account's statement shows the same €100 arriving three days later.
      const bRes = await importAndWait(token, {
        accountId: other.id,
        filename: 'b.csv',
        csv: [
          'Date,Amount,Description',
          '2026-07-13,100.00,From checking',
        ].join('\n'),
        mapping: MAPPING,
      });
      expect(bRes.status).toBe(201);
      const bBatch = (
        bRes.body as { batch: { id: string; rows: { id: string }[] } }
      ).batch;

      // Marking it a transfer surfaces a warning note rather than silently
      // merging (which once dropped genuine repeats) — the user Skips if it's
      // the same movement, so nothing is lost or double-counted behind the scenes.
      const reviewed = await request(http)
        .patch(`/imports/${bBatch.id}/rows/${bBatch.rows[0].id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ counterAccountId: accountId })
        .expect(200);
      expect(reviewed.body).toMatchObject({ status: 'READY' });
      expect(reviewed.body.note).toContain('Possible duplicate');
    });

    it('undoes a committed batch, restoring transactions and balance', async () => {
      const batch = await doImport();
      await request(http)
        .post(`/imports/${batch.id}/commit`)
        .set('Authorization', `Bearer ${token}`)
        .expect(201);
      expect(await getBalance(accountId)).toBe(620_000);

      await request(http)
        .post(`/imports/${batch.id}/undo`)
        .set('Authorization', `Bearer ${token}`)
        .expect(201);
      expect(await getBalance(accountId)).toBe(500_000);
      const txns = await request(http)
        .get('/transactions')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(txns.body).toMatchObject({ total: 0 });
    });

    it('reopens an undone batch so it can be committed again', async () => {
      const batch = await doImport();
      await request(http)
        .post(`/imports/${batch.id}/commit`)
        .set('Authorization', `Bearer ${token}`)
        .expect(201);
      await request(http)
        .post(`/imports/${batch.id}/undo`)
        .set('Authorization', `Bearer ${token}`)
        .expect(201);

      const reopened = await request(http)
        .post(`/imports/${batch.id}/reopen`)
        .set('Authorization', `Bearer ${token}`)
        .expect(201);
      // Back to a reviewable state with the rows preserved (the undo restored
      // the committed rows to READY, the unreviewed SPAR row stayed as it was).
      expect(reopened.body).toMatchObject({ status: 'PENDING_REVIEW' });
      expect(reopened.body.rows).toHaveLength(3);

      // Re-committing posts the same transactions and balance as the first time.
      await request(http)
        .post(`/imports/${batch.id}/commit`)
        .set('Authorization', `Bearer ${token}`)
        .expect(201);
      expect(await getBalance(accountId)).toBe(620_000);
      const txns = await request(http)
        .get('/transactions')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(txns.body).toMatchObject({ total: 2 });
    });

    it('rejects reopening a batch that was not undone', async () => {
      const batch = await doImport();
      await request(http)
        .post(`/imports/${batch.id}/reopen`)
        .set('Authorization', `Bearer ${token}`)
        .expect(409);
    });

    it('remembers the column mapping per account', async () => {
      await doImport();
      const saved = await request(http)
        .get(`/imports/mapping/${accountId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(saved.body).toMatchObject({ dateColumn: 'Date' });

      // A second import without a mapping reuses the saved one.
      const second = await doImport(
        'Date,Amount,Description\n2026-09-01,-5.00,Some Shop',
        false,
      );
      expect(second.rows).toHaveLength(1);
    });

    it('reports categorization accuracy for committed predictions', async () => {
      const batch = await doImport();
      await request(http)
        .post(`/imports/${batch.id}/commit`)
        .set('Authorization', `Bearer ${token}`)
        .expect(201);

      const stats = await request(http)
        .get('/imports/stats/accuracy')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      // Rent + Salary were predicted and kept → 2/2 correct.
      expect(stats.body).toMatchObject({
        overall: { predicted: 2, correct: 2, accuracy: 1 },
      });
    });

    it('keeps imports isolated between users', async () => {
      const batch = await doImport();
      const otherToken = await registerUser('import-other@example.com');

      await request(http)
        .get(`/imports/${batch.id}`)
        .set('Authorization', `Bearer ${otherToken}`)
        .expect(404);
      // Importing is a background job now, so a rejection arrives as a failed
      // job rather than a 4xx on the POST. The refusal still happens and the
      // reason still reaches the caller — it is one poll later.
      const started = await request(http)
        .post('/imports')
        .set('Authorization', `Bearer ${otherToken}`)
        .send({ accountId, filename: 'x.csv', csv: CSV, mapping: MAPPING })
        .expect(201);
      const { jobId } = started.body as { jobId: string };
      let outcome = { status: 'running', error: '' };
      for (let i = 0; i < 200 && outcome.status === 'running'; i++) {
        const job = await request(http)
          .get(`/jobs/${jobId}`)
          .set('Authorization', `Bearer ${otherToken}`)
          .expect(200);
        outcome = job.body as { status: string; error: string };
        if (outcome.status === 'running') {
          await new Promise((r) => setTimeout(r, 20));
        }
      }
      expect(outcome.status).toBe('error');
      expect(outcome.error).toMatch(/not found/i);
    });
  });

  describe('recurring rules', () => {
    let accountId: string;
    let rentId: string;
    let salaryId: string;

    beforeEach(async () => {
      accountId = (await createAccount(100_000)).id;
      rentId = (await createSubcategory('Monthly Rent', 'Bills')).id;
      salaryId = (await createSubcategory('Paycheck', 'Income')).id;
    });

    const createRule = async (
      body: Record<string, unknown>,
      asToken = token,
      expected = 201,
    ) => {
      const res = await request(http)
        .post('/recurring')
        .set('Authorization', `Bearer ${asToken}`)
        .send({ accountId, ...body })
        .expect(expected);
      return res.body as { id: string };
    };

    const run = async (asToken = token) => {
      const res = await request(http)
        .post('/recurring/run')
        .set('Authorization', `Bearer ${asToken}`)
        .expect(201);
      return res.body as {
        rulesProcessed: number;
        transactionsCreated: number;
      };
    };

    const listRules = async () => {
      const res = await request(http)
        .get('/recurring')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      return res.body as {
        id: string;
        active: boolean;
        occurrencesCreated: number;
        annualizedCents: number;
        progress: number | null;
      }[];
    };

    const txnCount = async (): Promise<number> => {
      const res = await request(http)
        .get('/transactions')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      return (res.body as { total: number }).total;
    };

    it('creates a rule and reports its annualized cost', async () => {
      await createRule({
        type: 'EXPENSE',
        amount: 5_000,
        subcategoryId: rentId,
        cadence: 'MONTHLY',
        startDate: '2020-01-01',
      });
      const rules = await listRules();
      expect(rules).toHaveLength(1);
      expect(rules[0].annualizedCents).toBe(60_000);
    });

    it('rejects a type/category mismatch', async () => {
      await createRule(
        {
          type: 'INCOME',
          amount: 1_000,
          subcategoryId: rentId, // a Bills subcategory
          cadence: 'MONTHLY',
          startDate: '2020-01-01',
        },
        token,
        400,
      );
    });

    it('posts due installments, moves the balance, then deactivates', async () => {
      await createRule({
        type: 'EXPENSE',
        amount: 20_000,
        subcategoryId: rentId,
        cadence: 'MONTHLY',
        startDate: '2020-01-01',
        maxOccurrences: 3,
      });

      expect((await run()).transactionsCreated).toBe(3);
      expect(await getBalance(accountId)).toBe(40_000); // 100k − 3×20k
      expect(await txnCount()).toBe(3);

      // Idempotent once complete.
      expect((await run()).transactionsCreated).toBe(0);
      const [rule] = await listRules();
      expect(rule).toMatchObject({
        active: false,
        occurrencesCreated: 3,
        progress: 1,
      });
    });

    it('stops at the end date', async () => {
      await createRule({
        type: 'EXPENSE',
        amount: 1_000,
        subcategoryId: rentId,
        cadence: 'MONTHLY',
        startDate: '2020-01-01',
        endDate: '2020-03-31',
      });
      expect((await run()).transactionsCreated).toBe(3); // Jan, Feb, Mar
      const [rule] = await listRules();
      expect(rule.active).toBe(false);
    });

    it('does not post a rule that starts in the future', async () => {
      await createRule({
        type: 'INCOME',
        amount: 300_000,
        subcategoryId: salaryId,
        cadence: 'MONTHLY',
        startDate: '2099-01-01',
      });
      expect((await run()).transactionsCreated).toBe(0);
      expect(await getBalance(accountId)).toBe(100_000);
    });

    it('pauses and resumes posting', async () => {
      const rule = await createRule({
        type: 'EXPENSE',
        amount: 1_000,
        subcategoryId: rentId,
        cadence: 'MONTHLY',
        startDate: '2020-01-01',
        maxOccurrences: 2,
      });
      await request(http)
        .patch(`/recurring/${rule.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ active: false })
        .expect(200);
      expect((await run()).transactionsCreated).toBe(0);

      await request(http)
        .patch(`/recurring/${rule.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ active: true })
        .expect(200);
      expect((await run()).transactionsCreated).toBe(2);
    });

    it('keeps generated transactions when the rule is deleted', async () => {
      const rule = await createRule({
        type: 'EXPENSE',
        amount: 1_000,
        subcategoryId: rentId,
        cadence: 'MONTHLY',
        startDate: '2020-01-01',
        maxOccurrences: 1,
      });
      await run();
      expect(await txnCount()).toBe(1);
      await request(http)
        .delete(`/recurring/${rule.id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(await txnCount()).toBe(1);
    });

    it('keeps rules isolated between users', async () => {
      const rule = await createRule({
        type: 'EXPENSE',
        amount: 1_000,
        subcategoryId: rentId,
        cadence: 'MONTHLY',
        startDate: '2020-01-01',
      });
      const otherToken = await registerUser('recurring-other@example.com');

      const theirs = await request(http)
        .get('/recurring')
        .set('Authorization', `Bearer ${otherToken}`)
        .expect(200);
      expect(theirs.body).toEqual([]);

      await request(http)
        .patch(`/recurring/${rule.id}`)
        .set('Authorization', `Bearer ${otherToken}`)
        .send({ active: false })
        .expect(404);

      // Running as the other user must not post the main user's rule.
      expect((await run(otherToken)).transactionsCreated).toBe(0);
    });

    it('does not double-post when run concurrently', async () => {
      await createRule({
        type: 'EXPENSE',
        amount: 10_000,
        subcategoryId: rentId,
        cadence: 'MONTHLY',
        startDate: '2020-01-01',
        maxOccurrences: 1,
      });
      const [a, b] = await Promise.all([run(), run()]);
      expect(a.transactionsCreated + b.transactionsCreated).toBe(1);
      expect(await txnCount()).toBe(1);
      expect(await getBalance(accountId)).toBe(90_000);
    });

    it('blocks deleting an account that still has a recurring rule', async () => {
      await createRule({
        type: 'EXPENSE',
        amount: 1_000,
        subcategoryId: rentId,
        cadence: 'MONTHLY',
        startDate: '2099-01-01', // future → no transactions, isolates the rule ref
      });
      await request(http)
        .delete(`/accounts/${accountId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(409);
    });

    // The account half of this pair has been guarded since 18 September; the
    // subcategory half was written at the same time and never covered, so a
    // delete that hit the required relation came back as a bare 500.
    it('blocks deleting a subcategory that still has a recurring rule', async () => {
      await createRule({
        type: 'EXPENSE',
        amount: 1_000,
        subcategoryId: rentId,
        cadence: 'MONTHLY',
        startDate: '2099-01-01',
      });
      const res = await request(http)
        .delete(`/subcategories/${rentId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(409);
      expect((res.body as { message: string }).message).toContain(
        'recurring transaction(s)',
      );
    });
  });

  /**
   * Every reference below is ON DELETE SET NULL, so the database accepts the
   * delete and quietly strips the link instead of refusing. Each of these
   * guards exists because that silence cost something real, and each is
   * pinned here because the guards were written one at a time and the
   * un-mirrored half is exactly what went missing every time.
   */
  describe('delete guards against silent unlinking', () => {
    type StagedRow = { id: string };
    type StagedBatch = { id: string; rows: StagedRow[] };
    let accountId: string;

    beforeEach(async () => {
      accountId = (await createAccount(100_000)).id;
    });

    it('blocks deleting an account a reminder is scoped to', async () => {
      await request(http)
        .post('/reminders')
        .set('Authorization', `Bearer ${token}`)
        .send({
          label: 'Gym membership',
          accountId,
          dueDate: '2099-01-01',
          amountCents: 3_000,
        })
        .expect(201);

      // Without the guard this returns 204 and the reminder silently loses its
      // scope — which is the whole mechanism keeping two same-category
      // reminders from settling against each other's payments.
      const res = await request(http)
        .delete(`/accounts/${accountId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(409);
      expect((res.body as { message: string }).message).toContain('reminder');
    });

    it('blocks deleting an account a row under review transfers into', async () => {
      const destination = (await createAccount(0, token, { name: 'Savings' }))
        .id;
      const batch = await importAndWait(token, {
        accountId,
        filename: 'statement.csv',
        csv: 'Date,Amount,Description\n2026-09-01,-50.00,Move to savings',
        mapping: {
          dateColumn: 'Date',
          amountColumn: 'Amount',
          descriptionColumn: 'Description',
          hasHeader: true,
        },
      });
      expect(batch.status).toBe(201);
      const staged = (batch.body as { batch: StagedBatch }).batch;

      // Mark the row a transfer, then leave the batch in review.
      await request(http)
        .patch(`/imports/${staged.id}/rows/${staged.rows[0].id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ counterAccountId: destination })
        .expect(200);

      await request(http)
        .delete(`/accounts/${destination}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(409);
    });

    it('blocks deleting a subcategory a row under review is filed under', async () => {
      const subcategoryId = (await createSubcategory('Hardware', 'Expenses'))
        .id;
      const batch = await importAndWait(token, {
        accountId,
        filename: 'statement.csv',
        csv: 'Date,Amount,Description\n2026-09-01,-20.00,Obi Baumarkt',
        mapping: {
          dateColumn: 'Date',
          amountColumn: 'Amount',
          descriptionColumn: 'Description',
          hasHeader: true,
        },
      });
      expect(batch.status).toBe(201);
      const staged = (batch.body as { batch: StagedBatch }).batch;

      await request(http)
        .patch(`/imports/${staged.id}/rows/${staged.rows[0].id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ subcategoryId })
        .expect(200);

      // The FK nulls the row's category, the commit's `committable` filter then
      // skips it, and the batch reports COMMITTED with that row's money simply
      // absent — no transaction and no error anywhere.
      const res = await request(http)
        .delete(`/subcategories/${subcategoryId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(409);
      expect((res.body as { message: string }).message).toContain(
        'import review',
      );
    });
  });

  describe('budgets & reports', () => {
    let accountId: string;
    let groceriesId: string;
    let incomeId: string;
    const today = new Date().toISOString().slice(0, 10);

    beforeEach(async () => {
      accountId = (await createAccount(100_000)).id;
      groceriesId = (await createSubcategory('Weekly Groceries', 'Expenses'))
        .id;
      // Not 'Refunds': registration already seeds a subcategory by that name.
      incomeId = (await createSubcategory('Money Back', 'Income')).id;
    });

    const createTxn = async (body: Record<string, unknown>) => {
      const res = await request(http)
        .post('/transactions')
        .set('Authorization', `Bearer ${token}`)
        .send({ accountId, date: today, ...body })
        .expect(201);
      return res.body as { id: string };
    };

    const createBudget = async (
      body: Record<string, unknown>,
      expected = 201,
      asToken = token,
    ) => {
      const res = await request(http)
        .post('/budgets')
        .set('Authorization', `Bearer ${asToken}`)
        .send(body)
        .expect(expected);
      return res.body as { id: string };
    };

    const listBudgets = async (asToken = token, period?: string) => {
      const res = await request(http)
        .get(`/budgets${period ? `?period=${period}` : ''}`)
        .set('Authorization', `Bearer ${asToken}`)
        .expect(200);
      return res.body as {
        id: string;
        limit: number;
        monthlyLimit: number;
        isOverride: boolean;
        oneOffPeriod: string | null;
        period: string;
        spentCents: number;
        remainingCents: number;
        overBudget: boolean;
      }[];
    };

    it('creates subcategory and category budgets, rejecting bad scope', async () => {
      await createBudget({ monthlyLimit: 10_000, subcategoryId: groceriesId });
      await createBudget({ monthlyLimit: 50_000, category: 'Expenses' });

      await createBudget({ monthlyLimit: 1_000 }, 400); // neither scope
      await createBudget(
        {
          monthlyLimit: 1_000,
          subcategoryId: groceriesId,
          category: 'Expenses',
        },
        400, // both scopes
      );
      await createBudget(
        { monthlyLimit: 1_000, subcategoryId: groceriesId },
        409,
      ); // dup

      expect(await listBudgets()).toHaveLength(2);
    });

    it('rejects budgets outside the Expenses category', async () => {
      // Income, and non-Expenses spend types (Bills/Debts/Savings), are not budgetable.
      await createBudget({ monthlyLimit: 1_000, subcategoryId: incomeId }, 400);
      await createBudget({ monthlyLimit: 1_000, category: 'Bills' }, 400);
      const billsSub = (await createSubcategory('Water Utility', 'Bills')).id;
      await createBudget({ monthlyLimit: 1_000, subcategoryId: billsSub }, 400);
    });

    it('tracks monthly spending, nets reimbursements, and flags over-budget', async () => {
      await createBudget({ monthlyLimit: 10_000, subcategoryId: groceriesId });

      await createTxn({
        type: 'EXPENSE',
        amount: 6_000,
        subcategoryId: groceriesId,
      });
      expect(await listBudgets()).toEqual([
        expect.objectContaining({
          spentCents: 6_000,
          remainingCents: 4_000,
          overBudget: false,
        }),
      ]);

      const expense = await createTxn({
        type: 'EXPENSE',
        amount: 5_000,
        subcategoryId: groceriesId,
      });
      expect((await listBudgets())[0]).toMatchObject({
        spentCents: 11_000,
        overBudget: true,
      });

      // A reimbursement of that expense reduces the spend.
      await createTxn({
        type: 'INCOME',
        amount: 2_000,
        subcategoryId: incomeId,
        parentTransactionId: expense.id,
      });
      expect((await listBudgets())[0]).toMatchObject({
        spentCents: 9_000,
        overBudget: false,
      });
    });

    it('nets a reimbursement that only arrives the following month', async () => {
      // Regression: budget spend used to require the payback itself to fall in
      // the period, so an expense repaid later stayed fully counted against the
      // month's budget (and credited a month that had no spending).
      const later = new Date();
      later.setDate(1);
      later.setMonth(later.getMonth() + 1);
      later.setDate(5);
      const laterDate = later.toISOString().slice(0, 10);
      const laterPeriod = laterDate.slice(0, 7);

      await createBudget({ monthlyLimit: 10_000, subcategoryId: groceriesId });
      const expense = await createTxn({
        type: 'EXPENSE',
        amount: 8_000,
        subcategoryId: groceriesId,
      });
      await createTxn({
        type: 'INCOME',
        amount: 8_000,
        subcategoryId: incomeId,
        parentTransactionId: expense.id,
        date: laterDate,
      });

      // Fully repaid, so this month's budget must not still count it...
      expect((await listBudgets())[0]).toMatchObject({ spentCents: 0 });
      // ...and next month must not gain a credit for spending it never had.
      expect((await listBudgets(token, laterPeriod))[0]).toMatchObject({
        spentCents: 0,
      });
    });

    it('ignores a reimbursement whose parent is an internal move', async () => {
      await createBudget({ monthlyLimit: 10_000, subcategoryId: groceriesId });
      const parent = await createTxn({
        type: 'EXPENSE',
        amount: 6_000,
        subcategoryId: groceriesId,
        excludeFromStats: true,
      });
      await createTxn({
        type: 'INCOME',
        amount: 2_000,
        subcategoryId: incomeId,
        parentTransactionId: parent.id,
      });
      // The internal expense is excluded; its payback must not push spend below 0.
      expect((await listBudgets())[0]).toMatchObject({ spentCents: 0 });
    });

    it('updates a budget limit and isolates budgets between users', async () => {
      const budget = await createBudget({
        monthlyLimit: 10_000,
        subcategoryId: groceriesId,
      });
      const updated = await request(http)
        .patch(`/budgets/${budget.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ monthlyLimit: 20_000 })
        .expect(200);
      expect(updated.body).toMatchObject({ monthlyLimit: 20_000 });

      const otherToken = await registerUser('budget-other@example.com');
      expect(await listBudgets(otherToken)).toEqual([]);
      await request(http)
        .patch(`/budgets/${budget.id}`)
        .set('Authorization', `Bearer ${otherToken}`)
        .send({ monthlyLimit: 999 })
        .expect(404);
    });

    it('overrides a budget limit for one month and reverts it', async () => {
      const period = new Date().toISOString().slice(0, 7);
      const otherMonth = '2020-01';
      const budget = await createBudget({
        monthlyLimit: 30_000,
        subcategoryId: groceriesId,
      });

      // No override yet: the effective limit is the recurring base.
      expect((await listBudgets(token, period))[0]).toMatchObject({
        limit: 30_000,
        monthlyLimit: 30_000,
        isOverride: false,
      });

      // Override just this month.
      const set = await request(http)
        .put(`/budgets/${budget.id}/periods/${period}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ limit: 50_000 })
        .expect(200);
      expect(set.body).toMatchObject({
        period,
        limit: 50_000,
        monthlyLimit: 30_000,
        isOverride: true,
      });

      // This month reflects the override; another month still shows the base.
      expect((await listBudgets(token, period))[0]).toMatchObject({
        limit: 50_000,
        isOverride: true,
      });
      expect((await listBudgets(token, otherMonth))[0]).toMatchObject({
        limit: 30_000,
        isOverride: false,
      });

      // Clearing the override reverts that month to the base.
      await request(http)
        .delete(`/budgets/${budget.id}/periods/${period}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect((await listBudgets(token, period))[0]).toMatchObject({
        limit: 30_000,
        isOverride: false,
      });
    });

    it('rejects a malformed budget period label', async () => {
      const budget = await createBudget({
        monthlyLimit: 10_000,
        subcategoryId: groceriesId,
      });
      await request(http)
        .put(`/budgets/${budget.id}/periods/2026-13`)
        .set('Authorization', `Bearer ${token}`)
        .send({ limit: 5_000 })
        .expect(400);
    });

    it('creates a one-off budget that shows only in its own month', async () => {
      const thisMonth = new Date().toISOString().slice(0, 7);
      const otherMonth = '2020-01';
      await createBudget({
        monthlyLimit: 20_000,
        subcategoryId: groceriesId,
        oneOffPeriod: thisMonth,
      });
      const here = await listBudgets(token, thisMonth);
      expect(here).toHaveLength(1);
      expect(here[0]).toMatchObject({ oneOffPeriod: thisMonth, limit: 20_000 });
      // A one-off never appears in another month.
      expect(await listBudgets(token, otherMonth)).toHaveLength(0);
    });

    it('deletes every budget with the bulk endpoint', async () => {
      await createBudget({ monthlyLimit: 10_000, subcategoryId: groceriesId });
      await createBudget({ monthlyLimit: 50_000, category: 'Expenses' });
      const del = await request(http)
        .delete('/budgets')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(del.body).toMatchObject({ deleted: 2 });
      expect(await listBudgets()).toHaveLength(0);
    });

    it('clears a month: reverts overrides and removes one-offs, keeping recurring', async () => {
      const period = new Date().toISOString().slice(0, 7);
      // A recurring budget with a this-month override...
      const recurring = await createBudget({
        monthlyLimit: 30_000,
        subcategoryId: groceriesId,
      });
      await request(http)
        .put(`/budgets/${recurring.id}/periods/${period}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ limit: 50_000 })
        .expect(200);
      // ...and a one-off budget living in this month.
      await createBudget({
        monthlyLimit: 20_000,
        category: 'Expenses',
        oneOffPeriod: period,
      });
      expect(await listBudgets(token, period)).toHaveLength(2);

      const cleared = await request(http)
        .delete(`/budgets/month/${period}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(cleared.body).toMatchObject({
        period,
        clearedOverrides: 1,
        deletedOneOffs: 1,
      });

      // The recurring budget survives at its default; the one-off is gone.
      const after = await listBudgets(token, period);
      expect(after).toHaveLength(1);
      expect(after[0]).toMatchObject({
        id: recurring.id,
        limit: 30_000,
        isOverride: false,
      });
    });

    // A transfer only cancels out while both ends are counted. Moving money to
    // an account flagged out of net worth is the counted set genuinely losing
    // it — and treating that as zero left the line disagreeing with the very
    // balances it claims to add up.
    it('counts a transfer that leaves the net-worth set, and one returning', async () => {
      const counted = (await createAccount(100_000)).id;
      const pocket = await request(http)
        .post('/accounts')
        .set('Authorization', `Bearer ${token}`)
        .send({
          name: `Pocket ${Date.now()}`,
          type: 'cash',
          currency: 'EUR',
          initialBalance: 0,
          countInNetWorth: false,
        })
        .expect(201);
      const excluded = (pocket.body as { id: string }).id;

      const netWorth = async () => {
        const res = await request(http)
          .get('/reports/net-worth?months=1')
          .set('Authorization', `Bearer ${token}`)
          .expect(200);
        const series = res.body as { netWorthCents: number }[];
        return series[series.length - 1].netWorthCents;
      };

      const before = await netWorth();

      // Out of the counted set: net worth falls by the full amount.
      await request(http)
        .post('/transactions')
        .set('Authorization', `Bearer ${token}`)
        .send({
          type: 'TRANSFER',
          date: today,
          amount: 30_000,
          accountId: counted,
          counterAccountId: excluded,
        })
        .expect(201);
      expect(await netWorth()).toBe(before - 30_000);

      // Part of it comes back: net worth rises again by that much.
      await request(http)
        .post('/transactions')
        .set('Authorization', `Bearer ${token}`)
        .send({
          type: 'TRANSFER',
          date: today,
          amount: 10_000,
          accountId: excluded,
          counterAccountId: counted,
        })
        .expect(201);
      expect(await netWorth()).toBe(before - 20_000);

      // And a move wholly inside the counted set still cancels out.
      const other = (await createAccount(0)).id;
      await request(http)
        .post('/transactions')
        .set('Authorization', `Bearer ${token}`)
        .send({
          type: 'TRANSFER',
          date: today,
          amount: 5_000,
          accountId: counted,
          counterAccountId: other,
        })
        .expect(201);
      expect(await netWorth()).toBe(before - 20_000);
    });

    // The rule computeSpent implements — an account already in the display
    // currency contributes its own amount, only the rest converts — also lives
    // in transaction-stats and reports. Nothing held the three together, and
    // they have disagreed before: the budget card once read $223.06 for the
    // month the spending card called $215.82.
    it('agrees with the spending stats about the same month', async () => {
      const foreign = (
        await createAccount(0, token, { currency: 'KZT', name: 'Tenge' })
      ).id;

      await createTxn({
        type: 'EXPENSE',
        amount: 4_000,
        subcategoryId: groceriesId,
      });
      await request(http)
        .post('/transactions')
        .set('Authorization', `Bearer ${token}`)
        .send({
          type: 'EXPENSE',
          date: today,
          amount: 500_000,
          accountId: foreign,
          subcategoryId: groceriesId,
        })
        .expect(201);

      await createBudget({ subcategoryId: groceriesId, monthlyLimit: 100_000 });

      const [budgets, stats] = await Promise.all([
        listBudgets(),
        request(http)
          .get('/transactions/stats')
          .set('Authorization', `Bearer ${token}`)
          .expect(200),
      ]);
      const mine = budgets.find((b) => b.subcategory?.id === groceriesId);
      const category = (
        stats.body as {
          byCategory: { subcategoryId: string; amount: number }[];
        }
      ).byCategory.find((c) => c.subcategoryId === groceriesId);

      expect(mine).toBeDefined();
      expect(category).toBeDefined();
      // Both are the same spending, summed the same way, so they agree to
      // the cent — whatever the rate happens to be.
      expect(mine?.spentCents).toBe(category?.amount);
    });

    it('reports net worth over time', async () => {
      await createTxn({
        type: 'INCOME',
        amount: 50_000,
        subcategoryId: incomeId,
      });
      await createTxn({
        type: 'EXPENSE',
        amount: 20_000,
        subcategoryId: groceriesId,
      });

      const res = await request(http)
        .get('/reports/net-worth?months=1')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      const series = res.body as { month: string; netWorthCents: number }[];
      // 100k start + 50k income − 20k expense
      expect(series[series.length - 1].netWorthCents).toBe(130_000);
    });

    it('exports transactions as CSV with escaping', async () => {
      await createTxn({
        type: 'EXPENSE',
        amount: 1_250,
        subcategoryId: groceriesId,
        description: 'Shop, the big one',
      });
      // Untrusted description (e.g. from an imported statement) must not become
      // an executable spreadsheet formula.
      await createTxn({
        type: 'EXPENSE',
        amount: 500,
        subcategoryId: groceriesId,
        description: '=HYPERLINK("http://evil")',
      });
      const res = await request(http)
        .get('/reports/transactions.csv')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(res.headers['content-type']).toContain('text/csv');
      expect(res.text).toContain(
        'Date,Account,Type,Category,Description,Currency,Amount',
      );
      expect(res.text).toContain('"Shop, the big one"');
      expect(res.text).toContain('-12.50');
      expect(res.text).toContain(`"'=HYPERLINK`);
      expect(res.text).not.toContain('"=HYPERLINK');
    });

    it('exports everything as JSON without credentials', async () => {
      await createTxn({
        type: 'EXPENSE',
        amount: 1_000,
        subcategoryId: groceriesId,
      });
      await createBudget({ monthlyLimit: 10_000, subcategoryId: groceriesId });

      const res = await request(http)
        .get('/reports/export.json')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      const body = res.body as Record<string, unknown[]> & {
        user: Record<string, unknown>;
      };
      expect(body.user).toEqual({
        email: 'main@example.com',
        baseCurrency: 'EUR',
        createdAt: expect.any(String) as unknown,
      });
      // The account this test created, plus the Cash account registration seeds.
      expect(body.accounts).toHaveLength(2);
      expect(body.transactions).toHaveLength(1);
      expect(body.budgets).toHaveLength(1);
      expect(JSON.stringify(body)).not.toContain('passwordHash');
    });

    it('warns about outlier amounts on create (non-blocking)', async () => {
      // Build up a typical-groceries history first.
      for (const amount of [1200, 1300, 1250, 1400, 1350, 1100, 1450, 1500]) {
        await createTxn({
          type: 'EXPENSE',
          amount,
          subcategoryId: groceriesId,
        });
      }

      const normal = await request(http)
        .post('/transactions')
        .set('Authorization', `Bearer ${token}`)
        .send({
          type: 'EXPENSE',
          amount: 1_600,
          date: today,
          accountId,
          subcategoryId: groceriesId,
        })
        .expect(201);
      expect((normal.body as { outlier: unknown }).outlier).toBeNull();

      const huge = await request(http)
        .post('/transactions')
        .set('Authorization', `Bearer ${token}`)
        .send({
          type: 'EXPENSE',
          amount: 50_000,
          date: today,
          accountId,
          subcategoryId: groceriesId,
        })
        .expect(201);
      expect((huge.body as { outlier: unknown }).outlier).toMatchObject({
        direction: 'high',
      });
      // Non-blocking: the transaction was still created.
      expect(await getBalance(accountId)).toBeLessThan(100_000);
    });
  });

  describe('reminders', () => {
    const addReminder = (body: Record<string, unknown>, expected = 201) =>
      request(http)
        .post('/reminders')
        .set('Authorization', `Bearer ${token}`)
        .send(body)
        .expect(expected);

    // Two people, one category, each paying from their own card: without an
    // account on the reminder either payment settles both.
    describe('scoped to one account', () => {
      let n = 0;
      const setup = async () => {
        const mine = (await createAccount(100_000)).id;
        const theirs = (await createAccount(100_000)).id;
        // Unique per test: subcategory names are unique per user.
        const gym = (await createSubcategory(`Gym ${++n}`, 'Subscriptions')).id;
        return { mine, theirs, gym };
      };

      const pay = (accountId: string, gym: string, amount: number) =>
        request(http)
          .post('/transactions')
          .set('Authorization', `Bearer ${token}`)
          .send({
            type: 'EXPENSE',
            date: '2026-08-25',
            amount,
            accountId,
            subcategoryId: gym,
          })
          .expect(201);

      const dueDateOf = async (id: string) => {
        const res = await request(http)
          .get('/reminders')
          .set('Authorization', `Bearer ${token}`)
          .expect(200);
        const found = (res.body as { id: string; dueDate: string }[]).find(
          (r) => r.id === id,
        );
        return found?.dueDate?.slice(0, 10);
      };

      it('is not settled by the other account paying the same category', async () => {
        const { mine, theirs, gym } = await setup();
        const created = await addReminder({
          label: 'Gym (mine)',
          subcategoryId: gym,
          accountId: mine,
          dueDate: '2026-08-24',
          cadence: 'monthly',
        });
        const id = (created.body as { id: string }).id;

        await pay(theirs, gym, 6_900);
        expect(await dueDateOf(id)).toBe('2026-08-24'); // unmoved

        await pay(mine, gym, 11_500);
        expect(await dueDateOf(id)).toBe('2026-09-24');
      });

      it('without an account, any payment still settles it', async () => {
        const { theirs, gym } = await setup();
        const created = await addReminder({
          label: 'Gym (either)',
          subcategoryId: gym,
          dueDate: '2026-08-24',
          cadence: 'monthly',
        });
        const id = (created.body as { id: string }).id;

        await pay(theirs, gym, 6_900);
        expect(await dueDateOf(id)).toBe('2026-09-24');
      });

      it("rejects another user's account", async () => {
        const otherToken = await registerUser('gym-other@example.com');
        const foreign = (await createAccount(0, otherToken)).id;
        await addReminder({ label: 'Gym', accountId: foreign }, 404);
      });
    });

    // The reported bug: a due date read out of an imported statement line keeps
    // that line's time of day, and a transaction entered by hand sits at
    // midnight. Compared as instants, paying on the due date looked early, so
    // the reminder stayed overdue however many times it was paid.
    it('is settled by a payment on the due date itself, whatever the times', async () => {
      const accountId = (await createAccount(100_000)).id;
      const sub = (await createSubcategory('Claude Pro', 'Subscriptions')).id;
      const created = await addReminder({
        label: 'Claude Pro',
        subcategoryId: sub,
        // 13:28:03, exactly as inherited from the statement line it came from.
        dueDate: '2026-08-27T13:28:03.000Z',
        cadence: 'monthly',
      });
      const id = (created.body as { id: string }).id;

      // Entered by hand: date only, so it lands at midnight — before the due
      // date as an instant, on it as a calendar day.
      await request(http)
        .post('/transactions')
        .set('Authorization', `Bearer ${token}`)
        .send({
          type: 'EXPENSE',
          date: '2026-08-27',
          amount: 2_142,
          accountId,
          subcategoryId: sub,
        })
        .expect(201);

      const res = await request(http)
        .get('/reminders')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      const found = (res.body as { id: string; dueDate: string }[]).find(
        (r) => r.id === id,
      );
      expect(found?.dueDate?.slice(0, 10)).toBe('2026-09-27');
    });

    it('adds a manual reminder and tracks installments to completion', async () => {
      const created = await addReminder({
        label: 'Sofa',
        dueDate: '2026-08-01',
        amountCents: 10_000,
        cadence: 'monthly',
        installmentsTotal: 3,
      });
      const id = (created.body as { id: string }).id;
      expect(created.body).toMatchObject({
        installmentsTotal: 3,
        installmentsPaid: 0,
        done: false,
      });

      const pay = () =>
        request(http)
          .post(`/reminders/${id}/paid`)
          .set('Authorization', `Bearer ${token}`)
          .expect(201);

      // First payment: count up, due date rolls to the next month, still open.
      const p1 = await pay();
      expect(p1.body).toMatchObject({ installmentsPaid: 1, done: false });
      expect((p1.body as { dueDate: string }).dueDate).toContain('2026-09-01');

      await pay();
      // Final payment completes and auto-dismisses.
      const p3 = await pay();
      expect(p3.body).toMatchObject({ installmentsPaid: 3, done: true });

      const list = await request(http)
        .get('/reminders')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(list.body).toHaveLength(1);
    });

    it('rejects mark-paid on a one-off reminder with nothing to advance', async () => {
      const created = await addReminder({ label: 'One-off donation' });
      await request(http)
        .post(`/reminders/${(created.body as { id: string }).id}/paid`)
        .set('Authorization', `Bearer ${token}`)
        .expect(400);
    });

    it('rolls a recurring reminder forward one period when marked paid', async () => {
      const created = await addReminder({
        label: 'Gym',
        dueDate: '2026-08-15',
        cadence: 'monthly',
      });
      const id = (created.body as { id: string }).id;
      const paid = await request(http)
        .post(`/reminders/${id}/paid`)
        .set('Authorization', `Bearer ${token}`)
        .expect(201);
      expect(paid.body).toMatchObject({ done: false });
      expect((paid.body as { dueDate: string }).dueDate).toContain(
        '2026-09-15',
      );
    });

    it('detects a recurring monthly bill and does not duplicate it', async () => {
      const acc = (await createAccount(100_000)).id;
      const sub = (await createSubcategory('Mobile Plan', 'Subscriptions')).id;
      const addExpense = (date: string) =>
        request(http)
          .post('/transactions')
          .set('Authorization', `Bearer ${token}`)
          .send({
            accountId: acc,
            date,
            type: 'EXPENSE',
            amount: 1_999,
            subcategoryId: sub,
          })
          .expect(201);
      // Two charges ~a month apart in different calendar months, both recent
      // (33 days apart always crosses a month boundary, whatever today's date).
      const iso = (daysAgo: number) => {
        const d = new Date();
        d.setUTCDate(d.getUTCDate() - daysAgo);
        return d.toISOString().slice(0, 10);
      };
      await addExpense(iso(38));
      await addExpense(iso(5));

      const first = await request(http)
        .post('/reminders/detect-recurring')
        .set('Authorization', `Bearer ${token}`)
        .expect(201);
      expect(first.body).toEqual({ created: 1 });

      const list = await request(http)
        .get('/reminders')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(
        (
          list.body as { cadence: string; subcategory: { id: string } | null }[]
        ).some((r) => r.cadence === 'monthly' && r.subcategory?.id === sub),
      ).toBe(true);

      // Re-running doesn't double up — the subcategory already has a reminder.
      const second = await request(http)
        .post('/reminders/detect-recurring')
        .set('Authorization', `Bearer ${token}`)
        .expect(201);
      expect(second.body).toEqual({ created: 0 });
    });

    it('reconciles a paid installment forward so it no longer shows overdue', async () => {
      const acc = (await createAccount(100_000)).id;
      const sub = (await createSubcategory('Phone Plan Installment', 'Bills'))
        .id;
      // A stale installment reminder: 6/12 paid, next payment "due" a past month.
      const created = await addReminder({
        label: 'Phone Plan Installment',
        subcategoryId: sub,
        cadence: 'monthly',
        dueDate: '2020-02-01',
        amountCents: 5_000,
        installmentsTotal: 12,
        installmentsPaid: 6,
      });
      const id = (created.body as { id: string }).id;

      // Import the payment that covers that due month.
      await request(http)
        .post('/transactions')
        .set('Authorization', `Bearer ${token}`)
        .send({
          accountId: acc,
          date: '2020-02-03',
          type: 'EXPENSE',
          amount: 5_000,
          subcategoryId: sub,
        })
        .expect(201);

      // Listing self-heals: it advances past the paid month, bumping the count.
      const list = await request(http)
        .get('/reminders')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      const r = (
        list.body as {
          id: string;
          dueDate: string;
          installmentsPaid: number;
          done: boolean;
        }[]
      ).find((x) => x.id === id);
      expect(r).toBeDefined();
      expect(r?.installmentsPaid).toBe(7);
      expect(r?.done).toBe(false);
      expect(r?.dueDate).toContain('2020-03-01');
    });
  });

  describe('split ledger', () => {
    const addFriend = async (name: string): Promise<string> => {
      const res = await request(http)
        .post('/split/friends')
        .set('Authorization', `Bearer ${token}`)
        .send({ name })
        .expect(201);
      return (res.body as { id: string }).id;
    };
    const balances = async () => {
      const res = await request(http)
        .get('/split/balances')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      return res.body as {
        balances: {
          fromId: string | null;
          fromName: string;
          toId: string | null;
          toName: string;
          amountCents: number;
        }[];
      };
    };

    /**
     * Split rows used to be stamped with User.baseCurrency, which is only a
     * display preference — so the label recorded which currency you happened
     * to be reading in that week, while balances() summed the stored cents
     * without ever consulting it. Changing the preference silently
     * re-denominated every historical split. The stored cents are ledger
     * amounts, so the label has to be the ledger's currency and nothing else.
     */
    it('reports split balances in the ledger currency, not the display one', async () => {
      const alex = await addFriend('Alex');
      await request(http)
        .post('/split/expenses')
        .set('Authorization', `Bearer ${token}`)
        .send({
          description: 'Taxi',
          amountCents: 2000,
          date: '2026-08-01',
          splitMethod: 'equal',
          participants: [{}, { friendId: alex }],
        })
        .expect(201);

      const before = await request(http)
        .get('/split/balances')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect((before.body as { currency: string }).currency).toBe('EUR');

      // Read everything in tenge from now on. The amounts already recorded did
      // not move, so neither may the currency they are reported in.
      await request(http)
        .patch('/auth/me')
        .set('Authorization', `Bearer ${token}`)
        .send({ baseCurrency: 'KZT' })
        .expect(200);

      const after = await request(http)
        .get('/split/balances')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      const body = after.body as {
        currency: string;
        balances: { amountCents: number }[];
      };
      expect(body.currency).toBe('EUR');
      expect(body.balances[0].amountCents).toBe(
        (before.body as { balances: { amountCents: number }[] }).balances[0]
          .amountCents,
      );
    });

    it('nets shared expenses and settlements into who-owes-whom', async () => {
      const alex = await addFriend('Alex');
      const sam = await addFriend('Sam');

      // You pay 30.00 for dinner, split equally among You, Alex, Sam → 10 each.
      await request(http)
        .post('/split/expenses')
        .set('Authorization', `Bearer ${token}`)
        .send({
          description: 'Dinner',
          amountCents: 3000,
          date: '2026-08-01',
          splitMethod: 'equal',
          participants: [{}, { friendId: alex }, { friendId: sam }],
        })
        .expect(201);

      // Alex pays 12.00 for a taxi, split You + Alex → 6 each. You owe Alex 6.
      await request(http)
        .post('/split/expenses')
        .set('Authorization', `Bearer ${token}`)
        .send({
          description: 'Taxi',
          amountCents: 1200,
          date: '2026-08-01',
          payerFriendId: alex,
          splitMethod: 'equal',
          participants: [{}, { friendId: alex }],
        })
        .expect(201);

      // Alex owes You 10 − 6 = 4; Sam owes You 10. (You-involving first, big first.)
      expect((await balances()).balances).toEqual([
        {
          fromId: sam,
          fromName: 'Sam',
          toId: null,
          toName: 'You',
          amountCents: 1000,
        },
        {
          fromId: alex,
          fromName: 'Alex',
          toId: null,
          toName: 'You',
          amountCents: 400,
        },
      ]);

      // Alex settles the 4.00 → only Sam's 10 remains.
      await request(http)
        .post('/split/settlements')
        .set('Authorization', `Bearer ${token}`)
        .send({ fromFriendId: alex, amountCents: 400 })
        .expect(201);

      expect((await balances()).balances).toEqual([
        {
          fromId: sam,
          fromName: 'Sam',
          toId: null,
          toName: 'You',
          amountCents: 1000,
        },
      ]);
    });

    it('rejects exact shares that do not add up, and blocks deleting a referenced friend', async () => {
      const jo = await addFriend('Jo');
      await request(http)
        .post('/split/expenses')
        .set('Authorization', `Bearer ${token}`)
        .send({
          description: 'Bad',
          amountCents: 1000,
          date: '2026-08-01',
          splitMethod: 'exact',
          participants: [
            { amountCents: 400 },
            { friendId: jo, amountCents: 400 },
          ],
        })
        .expect(400);

      await request(http)
        .post('/split/expenses')
        .set('Authorization', `Bearer ${token}`)
        .send({
          description: 'Books',
          amountCents: 1000,
          date: '2026-08-01',
          splitMethod: 'exact',
          participants: [
            { amountCents: 400 },
            { friendId: jo, amountCents: 600 },
          ],
        })
        .expect(201);

      await request(http)
        .delete(`/split/friends/${jo}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(409);
    });
  });
});
