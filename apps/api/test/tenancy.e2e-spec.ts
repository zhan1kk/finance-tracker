import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma.service';

/**
 * Two users, one database. User A builds one of everything; user B then
 * reaches for each of A's records by id — directly in the path, or as a
 * reference inside B's own records.
 *
 * Two oracles. First, A's own view of A's data, captured before B starts and
 * compared after every attack: nothing B does may change it. Second, the
 * reason PLAN.md gives for "404, not 403": another user's record must look
 * exactly like one that does not exist. So every attack is replayed with A's
 * ids swapped for a random one, and the two answers must be identical — and
 * a refusal, except a DELETE, which may answer a no-op either way.
 */
describe('Tenancy (e2e)', () => {
  let app: INestApplication<App>;
  let http: App;

  type Method = 'get' | 'post' | 'patch' | 'put' | 'delete';
  type Attack = [Method, string, Record<string, unknown>?];

  const call = (
    token: string,
    method: Method,
    path: string,
    body?: Record<string, unknown>,
  ) => {
    const req = request(http)
      [method](path)
      .set('Authorization', `Bearer ${token}`);
    return body ? req.send(body) : req;
  };

  const ok = async (
    token: string,
    method: Method,
    path: string,
    body?: Record<string, unknown>,
  ) => {
    const res = await call(token, method, path, body);
    if (res.status >= 300) {
      throw new Error(
        `${method.toUpperCase()} ${path} → ${res.status}: ${JSON.stringify(res.body)}`,
      );
    }
    return res.body as Record<string, unknown> & { id: string };
  };

  const register = async (email: string) =>
    (
      await request(http)
        .post('/auth/register')
        .send({ email, password: 'password123' })
        .expect(201)
    ).body.accessToken as string;

  const importAndWait = async (token: string, accountId: string) => {
    const { jobId } = await ok(token, 'post', '/imports', {
      accountId,
      filename: 'statement.csv',
      csv: [
        'Date,Amount,Description',
        '2026-07-01,-12.50,SPAR AMSTERDAM 4471',
        '2026-07-03,2000.00,Salary payment ACME',
      ].join('\n'),
      mapping: {
        dateColumn: 'Date',
        amountColumn: 'Amount',
        descriptionColumn: 'Description',
        dateFormat: 'ISO',
        decimalSeparator: '.',
        negativeIsExpense: true,
        hasHeader: true,
      },
    });
    for (let i = 0; i < 300; i++) {
      const job = await ok(token, 'get', `/jobs/${String(jobId)}`);
      if (job.status === 'done') {
        const { batch } = job.result as {
          batch: { id: string; rows: { id: string }[] };
        };
        return { jobId: String(jobId), batch };
      }
      if (job.status === 'error') throw new Error(String(job.error));
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error('import job did not finish');
  };

  const thisMonth = new Date().toISOString().slice(0, 7);
  const MARK = 'tenancy-a-marker';

  // A's world, and B's own records to point at A's.
  const a = {} as Record<string, string>;
  const b = {} as Record<string, string>;

  /** Everything A can see of A's own data. */
  const snapshotOfA = async () => {
    const paths = [
      '/accounts',
      '/subcategories',
      '/transactions?pageSize=100',
      '/rules',
      '/budgets',
      `/budgets?period=${thisMonth}`,
      '/recurring',
      '/reminders',
      '/split/friends',
      '/split/groups',
      `/split/groups/${a.group}`,
      '/split/expenses',
      '/split/settlements',
      '/split/balances',
      '/imports',
      `/imports/${a.batch}`,
      `/imports/mapping/${a.account}`,
      '/fx/rates?currency=KZT',
    ];
    const out: Record<string, unknown> = {};
    for (const p of paths) out[p] = await ok(a.token, 'get', p);
    return out;
  };
  let baseline: Record<string, unknown>;

  /** Swaps every one of A's ids in `text` for an id nobody owns. */
  const GHOST = '00000000-0000-4000-8000-000000000000';
  const ghostOf = (text: string) =>
    Object.entries(a)
      .filter(([k]) => k !== 'token')
      .reduce((t, [, id]) => t.split(id).join(GHOST), text);

  /**
   * Runs each attack as B, and again with A's ids replaced by GHOST. Returns
   * the attacks that succeeded, or whose answer told A's record apart from a
   * missing one.
   */
  const leaksOf = async (attacks: Attack[]) => {
    const leaks: string[] = [];
    for (const [method, path, body] of attacks) {
      const real = await call(b.token, method, path, body);
      const ghost = await call(
        b.token,
        method,
        ghostOf(path),
        body && (JSON.parse(ghostOf(JSON.stringify(body))) as typeof body),
      );
      const same =
        real.status === ghost.status && ghostOf(real.text) === ghost.text;
      const refused = real.status >= 400 || method === 'delete';
      if (!same || !refused) {
        leaks.push(
          `${method.toUpperCase()} ${path} → ${real.status} ${real.text.slice(0, 140)}` +
            (same
              ? ''
              : ` | missing id → ${ghost.status} ${ghost.text.slice(0, 140)}`),
        );
      }
    }
    return leaks;
  };

  /** A's data first: a change there is worse than any status code. */
  const expectNoLeaks = async (attacks: Attack[]) => {
    const leaks = await leaksOf(attacks);
    expect(await snapshotOfA()).toEqual(baseline);
    expect(leaks).toEqual([]);
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication({ bodyParser: false });
    configureApp(app);
    await app.init();
    await app.listen(0);
    http = app.getHttpServer();
    await app
      .get(PrismaService)
      .$executeRawUnsafe(
        'TRUNCATE "Transaction", "Account", "Subcategory", "RefreshToken", "User" CASCADE',
      );

    a.token = await register('tenant-a@example.com');
    b.token = await register('tenant-b@example.com');

    for (const [who, u] of [
      ['a', a],
      ['b', b],
    ] as const) {
      const t = u.token;
      u.account = (
        await ok(t, 'post', '/accounts', {
          name: `${who} checking`,
          type: 'checking',
          currency: 'EUR',
          initialBalance: 100_000,
        })
      ).id;
      u.sub = (
        await ok(t, 'post', '/subcategories', {
          name: `${who} coffee`,
          category: 'Expenses',
        })
      ).id;
      u.incomeSub = (
        await ok(t, 'post', '/subcategories', {
          name: `${who} payback`,
          category: 'Income',
        })
      ).id;
      u.tx = (
        await ok(t, 'post', '/transactions', {
          type: 'EXPENSE',
          date: '2026-07-01',
          amount: 1_000,
          accountId: u.account,
          subcategoryId: u.sub,
          description: `${who === 'a' ? MARK : 'b'} latte`,
        })
      ).id;
      u.income = (
        await ok(t, 'post', '/transactions', {
          type: 'INCOME',
          date: '2026-07-02',
          amount: 500,
          accountId: u.account,
          subcategoryId: u.incomeSub,
        })
      ).id;
      u.reminder = (
        await ok(t, 'post', '/reminders', {
          label: `${who} gym`,
          dueDate: '2099-01-01',
          amountCents: 3_000,
        })
      ).id;
      u.friend = (
        await ok(t, 'post', '/split/friends', { name: `${who}-pal` })
      ).id;
      u.group = (
        await ok(t, 'post', '/split/groups', {
          name: `${who} trip`,
          memberIds: [u.friend],
        })
      ).id;
      const imported = await importAndWait(t, u.account);
      u.batch = imported.batch.id;
      u.row = imported.batch.rows[0].id;
      u.job = imported.jobId;
    }

    a.rule = (
      await ok(a.token, 'post', '/rules', {
        pattern: 'tenancy cafe',
        subcategoryId: a.sub,
      })
    ).id;
    a.budget = (
      await ok(a.token, 'post', '/budgets', {
        monthlyLimit: 10_000,
        subcategoryId: a.sub,
      })
    ).id;
    a.oneOffBudget = (
      await ok(a.token, 'post', '/budgets', {
        monthlyLimit: 20_000,
        category: 'Expenses',
        oneOffPeriod: thisMonth,
      })
    ).id;
    a.recurring = (
      await ok(a.token, 'post', '/recurring', {
        type: 'EXPENSE',
        amount: 1_000,
        accountId: a.account,
        subcategoryId: a.sub,
        cadence: 'MONTHLY',
        startDate: '2099-01-01',
      })
    ).id;
    a.expense = (
      await ok(a.token, 'post', '/split/expenses', {
        description: 'A dinner',
        amountCents: 2_000,
        date: '2026-08-01',
        splitMethod: 'equal',
        participants: [{}, { friendId: a.friend }],
        groupId: a.group,
      })
    ).id;
    a.settlement = (
      await ok(a.token, 'post', '/split/settlements', {
        fromFriendId: a.friend,
        amountCents: 500,
        groupId: a.group,
      })
    ).id;
    await ok(a.token, 'post', '/fx/rates', {
      currency: 'KZT',
      date: '2026-09-01',
      rate: 500,
    });
    const rates = (await ok(a.token, 'get', '/fx/rates?currency=KZT')) as {
      rates?: { id: string }[];
    };
    // A made-up id would 404 for everyone and pass the attack for nothing.
    const rateId = rates.rates?.[0]?.id;
    if (!rateId) throw new Error(`no rate id in ${JSON.stringify(rates)}`);
    a.rate = rateId;

    baseline = await snapshotOfA();
  });

  afterAll(async () => {
    await app.close();
  });

  const expectAUntouched = async () =>
    expect(await snapshotOfA()).toEqual(baseline);

  it("hides A's records from every one of B's lists", async () => {
    const aIds = Object.entries(a)
      .filter(([k]) => k !== 'token')
      .map(([, v]) => v);
    const lists = [
      '/accounts',
      '/subcategories',
      '/transactions?pageSize=100',
      '/transactions/stats',
      '/transactions/unlinked-reimbursements',
      '/rules',
      '/budgets',
      '/recurring',
      '/reminders',
      '/split/friends',
      '/split/groups',
      '/split/expenses',
      '/split/settlements',
      '/split/balances',
      '/imports',
      '/jobs/running',
      '/fx/rates?currency=KZT',
      '/reports/export.json',
      '/reports/transactions.csv',
    ];
    const seen: string[] = [];
    for (const path of lists) {
      const res = await call(b.token, 'get', path);
      expect(res.status).toBe(200);
      const text = res.text;
      for (const id of [...aIds, MARK]) {
        if (text.includes(id)) seen.push(`${path} shows ${id}`);
      }
    }
    expect(seen).toEqual([]);

    // Positive control: A's own export does carry A's marker.
    const own = await call(a.token, 'get', '/reports/transactions.csv');
    expect(own.text).toContain(MARK);
  });

  it("cannot read, change or delete A's ledger records", async () => {
    await expectNoLeaks([
      ['get', `/accounts/${a.account}`],
      ['patch', `/accounts/${a.account}`, { name: 'Hacked' }],
      ['delete', `/accounts/${a.account}`],
      ['get', `/subcategories/${a.sub}`],
      ['patch', `/subcategories/${a.sub}`, { name: 'Hacked' }],
      ['delete', `/subcategories/${a.sub}`],
      ['get', `/transactions/${a.tx}`],
      ['patch', `/transactions/${a.tx}`, { amount: 1 }],
      [
        'post',
        `/transactions/${a.tx}/split`,
        {
          parts: [
            { amount: 500, subcategoryId: b.sub },
            { amount: 500, subcategoryId: b.sub },
          ],
        },
      ],
      [
        'patch',
        `/transactions/${a.income}/reimburses`,
        { parentTransactionId: null },
      ],
      ['delete', `/transactions/${a.tx}`],
    ]);
  });

  it("cannot act on A's import batch, its rows, its job or its mapping", async () => {
    const MAPPING = {
      dateColumn: 'Date',
      amountColumn: 'Amount',
      descriptionColumn: 'Description',
      dateFormat: 'ISO',
      decimalSeparator: '.',
      negativeIsExpense: true,
      hasHeader: true,
    };
    await expectNoLeaks([
      ['get', `/imports/${a.batch}`],
      ['get', `/imports/${a.batch}/benchmark`],
      ['patch', `/imports/${a.batch}/rows/${a.row}`, { subcategoryId: b.sub }],
      ['post', `/imports/${a.batch}/rows/${a.row}/flip`],
      ['post', `/imports/${a.batch}/rows/${a.row}/skip`, { skipped: true }],
      ['post', `/imports/${a.batch}/rows/${a.row}/include`],
      ['post', `/imports/${a.batch}/commit`],
      ['post', `/imports/${a.batch}/undo`],
      ['post', `/imports/${a.batch}/reopen`],
      ['delete', `/imports/${a.batch}`],
      ['get', `/imports/mapping/${a.account}`],
      ['put', `/imports/mapping/${a.account}`, MAPPING],
      ['get', `/jobs/${a.job}`],
    ]);
  });

  it("cannot change or delete A's rules, budgets and recurring rules", async () => {
    await expectNoLeaks([
      ['patch', `/rules/${a.rule}`, { subcategoryId: b.sub }],
      ['delete', `/rules/${a.rule}`],
      ['patch', `/budgets/${a.budget}`, { monthlyLimit: 1 }],
      ['put', `/budgets/${a.budget}/periods/${thisMonth}`, { limit: 1 }],
      ['delete', `/budgets/${a.budget}/periods/${thisMonth}`],
      ['delete', `/budgets/${a.budget}`],
      ['patch', `/recurring/${a.recurring}`, { active: false }],
      ['delete', `/recurring/${a.recurring}`],
    ]);
  });

  it("cannot settle, change or delete A's reminders", async () => {
    await expectNoLeaks([
      ['post', `/reminders/${a.reminder}/paid`],
      [
        'post',
        `/reminders/${a.reminder}/link-payment`,
        { transactionId: b.income },
      ],
      ['patch', `/reminders/${a.reminder}`, { done: true }],
      ['delete', `/reminders/${a.reminder}`],
    ]);
  });

  it("cannot reach into A's split ledger or exchange rates", async () => {
    await expectNoLeaks([
      ['get', `/split/groups/${a.group}`],
      ['patch', `/split/groups/${a.group}`, { name: 'hacked' }],
      ['post', `/split/groups/${a.group}/members`, { friendId: b.friend }],
      ['delete', `/split/groups/${a.group}/members/${a.friend}`],
      ['patch', `/split/expenses/${a.expense}`, { groupId: b.group }],
      ['delete', `/split/expenses/${a.expense}`],
      ['patch', `/split/settlements/${a.settlement}`, { groupId: b.group }],
      ['delete', `/split/settlements/${a.settlement}`],
      ['delete', `/split/groups/${a.group}`],
      ['delete', `/split/friends/${a.friend}`],
      ['delete', `/fx/rates/${a.rate}`],
    ]);
  });

  it("cannot point B's own records at A's", async () => {
    await expectNoLeaks([
      // Ledger
      [
        'post',
        '/transactions',
        {
          type: 'EXPENSE',
          date: '2026-07-05',
          amount: 100,
          accountId: b.account,
          subcategoryId: a.sub,
        },
      ],
      [
        'post',
        '/transactions',
        {
          type: 'INCOME',
          date: '2026-07-05',
          amount: 100,
          accountId: b.account,
          subcategoryId: b.incomeSub,
          parentTransactionId: a.tx,
        },
      ],
      [
        'post',
        '/transactions',
        {
          type: 'TRANSFER',
          date: '2026-07-05',
          amount: 100,
          accountId: b.account,
          counterAccountId: a.account,
        },
      ],
      ['patch', `/transactions/${b.tx}`, { subcategoryId: a.sub }],
      [
        'patch',
        `/transactions/${b.income}/reimburses`,
        { parentTransactionId: a.tx },
      ],
      // Rules, budgets, recurring
      ['post', '/rules', { pattern: 'b to a sub', subcategoryId: a.sub }],
      [
        'post',
        '/rules',
        { pattern: 'b to a acct', counterAccountId: a.account },
      ],
      ['post', '/budgets', { monthlyLimit: 1_000, subcategoryId: a.sub }],
      [
        'post',
        '/recurring',
        {
          type: 'EXPENSE',
          amount: 100,
          accountId: a.account,
          subcategoryId: b.sub,
          cadence: 'MONTHLY',
          startDate: '2020-01-01',
        },
      ],
      [
        'post',
        '/recurring',
        {
          type: 'EXPENSE',
          amount: 100,
          accountId: b.account,
          subcategoryId: a.sub,
          cadence: 'MONTHLY',
          startDate: '2099-01-01',
        },
      ],
      // Reminders and imports
      [
        'post',
        '/reminders',
        {
          label: 'b watches a',
          subcategoryId: a.sub,
          dueDate: '2099-01-01',
          amountCents: 100,
        },
      ],
      ['patch', `/imports/${b.batch}/rows/${b.row}`, { subcategoryId: a.sub }],
      // Split
      [
        'post',
        '/split/expenses',
        {
          description: 'b spends with a friend of a',
          amountCents: 1_000,
          date: '2026-08-01',
          splitMethod: 'equal',
          participants: [{}, { friendId: a.friend }],
        },
      ],
      [
        'post',
        '/split/expenses',
        {
          description: 'b spends into a group of a',
          amountCents: 1_000,
          date: '2026-08-01',
          splitMethod: 'equal',
          participants: [{}, { friendId: b.friend }],
          groupId: a.group,
        },
      ],
      [
        'post',
        '/split/settlements',
        { fromFriendId: a.friend, amountCents: 100 },
      ],
      ['post', '/split/groups', { name: 'b with a', memberIds: [a.friend] }],
      ['post', `/split/groups/${b.group}/members`, { friendId: a.friend }],
      ['patch', '/telegram/settings', { defaultAccountId: a.account }],
    ]);
  });

  // Last: these are B's own bulk operations, and they wipe B's data.
  describe("B's bulk operations stay inside B's data", () => {
    it('bulk edit and bulk delete ignore ids that belong to A', async () => {
      await call(b.token, 'patch', '/transactions/bulk', {
        ids: [a.tx],
        excludeFromStats: true,
      });
      await call(b.token, 'post', '/transactions/bulk-delete', {
        ids: [a.tx, a.income],
      });
      await call(b.token, 'post', '/rules/bulk', {
        rules: [{ pattern: 'bulk into a', subcategoryId: a.sub }],
      });
      const bRules = await call(b.token, 'get', '/rules');
      expect(bRules.text).not.toContain(a.sub);
      await expectAUntouched();
    });

    it('"delete all" deletes all of B\'s, and none of A\'s', async () => {
      for (const path of [
        '/transactions',
        '/budgets',
        `/budgets/month/${thisMonth}`,
        '/recurring',
      ]) {
        const res = await call(b.token, 'delete', path);
        expect(res.status).toBe(200);
      }
      const bTxns = await ok(b.token, 'get', '/transactions');
      expect(bTxns.total).toBe(0);
      await expectAUntouched();
    });
  });
});
