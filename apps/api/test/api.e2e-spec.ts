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

  const createAccount = async (initialBalance = 100_000, asToken = token) => {
    const res = await request(http)
      .post('/accounts')
      .set('Authorization', `Bearer ${asToken}`)
      .send({
        name: 'Checking',
        type: 'checking',
        currency: 'EUR',
        initialBalance,
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
      subcategoryId: string,
      amount: number,
      expectedStatus = 201,
    ) => {
      const res = await request(http)
        .post('/transactions')
        .set('Authorization', `Bearer ${token}`)
        .send({ date: '2026-07-01', amount, subcategoryId, accountId })
        .expect(expectedStatus);
      return res.body as { id: string };
    };

    it('income increases and expense decreases the account balance', async () => {
      await createTransaction(incomeId, 50_000);
      expect(await getBalance(accountId)).toBe(150_000);

      await createTransaction(expenseId, 2_000);
      expect(await getBalance(accountId)).toBe(148_000);
    });

    it('updating the amount adjusts the balance by the difference', async () => {
      const tx = await createTransaction(expenseId, 2_000);
      await request(http)
        .patch(`/transactions/${tx.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ amount: 3_000 })
        .expect(200);
      expect(await getBalance(accountId)).toBe(97_000);
    });

    it('deleting a transaction reverts its balance effect', async () => {
      const tx = await createTransaction(incomeId, 50_000);
      await request(http)
        .delete(`/transactions/${tx.id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(await getBalance(accountId)).toBe(100_000);
    });

    it('rejects zero, negative and fractional amounts', async () => {
      await createTransaction(expenseId, 0, 400);
      await createTransaction(expenseId, -500, 400);
      await createTransaction(expenseId, 10.5, 400);
    });

    it('returns 404 for an unknown subcategory', async () => {
      const res = await request(http)
        .post('/transactions')
        .set('Authorization', `Bearer ${token}`)
        .send({
          date: '2026-07-01',
          amount: 1_000,
          subcategoryId: '00000000-0000-0000-0000-000000000000',
          accountId,
        });
      expect(res.status).toBe(404);
    });

    it('refuses to delete an account that still has transactions', async () => {
      await createTransaction(expenseId, 1_000);
      await request(http)
        .delete(`/accounts/${accountId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(409);
    });

    it('refuses to change a subcategory category once it has transactions', async () => {
      await createTransaction(expenseId, 1_000);
      await request(http)
        .patch(`/subcategories/${expenseId}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ category: 'Income' })
        .expect(409);
    });
  });
});
