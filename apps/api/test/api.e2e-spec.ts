import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma.service';

describe('API (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let http: App;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    http = app.getHttpServer();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE "Transaction", "Account", "Subcategory" CASCADE',
    );
  });

  afterAll(async () => {
    await app.close();
  });

  const createAccount = async (initialBalance = 100_000) => {
    const res = await request(http)
      .post('/accounts')
      .send({
        name: 'Checking',
        type: 'checking',
        currency: 'EUR',
        initialBalance,
      })
      .expect(201);
    return res.body as { id: string; balance: number };
  };

  const createSubcategory = async (name: string, category: string) => {
    const res = await request(http)
      .post('/subcategories')
      .send({ name, category })
      .expect(201);
    return res.body as { id: string };
  };

  const getBalance = async (accountId: string): Promise<number> => {
    const res = await request(http).get(`/accounts/${accountId}`).expect(200);
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
        .send({ name: 'X', type: 'wallet', currency: 'EUR' })
        .expect(400);
    });

    it('rejects a non-integer balance (cents only)', async () => {
      await request(http)
        .post('/accounts')
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
        .send({ type: 'not-a-type' })
        .expect(400);
    });

    it('does not touch the balance on update (regression: balance reset to 0)', async () => {
      const account = await createAccount(120_000);
      await request(http)
        .patch(`/accounts/${account.id}`)
        .send({ name: 'Renamed' })
        .expect(200);
      expect(await getBalance(account.id)).toBe(120_000);
    });

    it('rejects direct balance edits', async () => {
      const account = await createAccount();
      await request(http)
        .patch(`/accounts/${account.id}`)
        .send({ initialBalance: 999_999 })
        .expect(400);
    });
  });

  describe('subcategories', () => {
    it('rejects a duplicate name', async () => {
      await createSubcategory('Groceries', 'Expenses');
      await request(http)
        .post('/subcategories')
        .send({ name: 'Groceries', category: 'Expenses' })
        .expect(409);
    });

    it('rejects renaming onto an existing name', async () => {
      await createSubcategory('Groceries', 'Expenses');
      const { id } = await createSubcategory('Dining Out', 'Expenses');
      await request(http)
        .patch(`/subcategories/${id}`)
        .send({ name: 'Groceries' })
        .expect(409);
    });
  });

  describe('transactions & balance math', () => {
    let accountId: string;
    let incomeId: string;
    let expenseId: string;

    beforeEach(async () => {
      accountId = (await createAccount(100_000)).id;
      incomeId = (await createSubcategory('Salary', 'Income')).id;
      expenseId = (await createSubcategory('Groceries', 'Expenses')).id;
    });

    const createTransaction = async (
      subcategoryId: string,
      amount: number,
      expectedStatus = 201,
    ) => {
      const res = await request(http)
        .post('/transactions')
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
        .send({ amount: 3_000 })
        .expect(200);
      expect(await getBalance(accountId)).toBe(97_000);
    });

    it('deleting a transaction reverts its balance effect', async () => {
      const tx = await createTransaction(incomeId, 50_000);
      await request(http).delete(`/transactions/${tx.id}`).expect(200);
      expect(await getBalance(accountId)).toBe(100_000);
    });

    it('rejects zero, negative and fractional amounts', async () => {
      await createTransaction(expenseId, 0, 400);
      await createTransaction(expenseId, -500, 400);
      await createTransaction(expenseId, 10.5, 400);
    });

    it('returns 404 for an unknown subcategory', async () => {
      const res = await request(http).post('/transactions').send({
        date: '2026-07-01',
        amount: 1_000,
        subcategoryId: '00000000-0000-0000-0000-000000000000',
        accountId,
      });
      expect(res.status).toBe(404);
    });

    it('refuses to delete an account that still has transactions', async () => {
      await createTransaction(expenseId, 1_000);
      await request(http).delete(`/accounts/${accountId}`).expect(409);
    });

    it('refuses to change a subcategory category once it has transactions', async () => {
      await createTransaction(expenseId, 1_000);
      await request(http)
        .patch(`/subcategories/${expenseId}`)
        .send({ category: 'Income' })
        .expect(409);
    });
  });
});
