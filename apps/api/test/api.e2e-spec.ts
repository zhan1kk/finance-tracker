import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma.service';

describe('API (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let http: App;
  let token: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();
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

  const registerUser = async (email: string): Promise<string> => {
    const res = await request(http)
      .post('/auth/register')
      .send({ email, password: 'password123' })
      .expect(201);
    return (res.body as { accessToken: string }).accessToken;
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
      })
      .expect(201);
    return res.body as { id: string; balance: number };
  };

  // Names must not collide with the defaults seeded on registration.
  const createSubcategory = async (
    name: string,
    category: string,
    asToken = token,
  ) => {
    const res = await request(http)
      .post('/subcategories')
      .set('Authorization', `Bearer ${asToken}`)
      .send({ name, category })
      .expect(201);
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

    it('rejects direct balance edits', async () => {
      const account = await createAccount();
      await request(http)
        .patch(`/accounts/${account.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ initialBalance: 999_999 })
        .expect(400);
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
      expect(accounts.body).toEqual([]);

      const transactions = await request(http)
        .get('/transactions')
        .set('Authorization', bearer)
        .expect(200);
      expect(transactions.body).toEqual([]);
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

    it('income increases and expense decreases the account balance', async () => {
      await createTransaction('INCOME', incomeId, 50_000);
      expect(await getBalance(accountId)).toBe(150_000);

      await createTransaction('EXPENSE', expenseId, 2_000);
      expect(await getBalance(accountId)).toBe(148_000);
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
});
