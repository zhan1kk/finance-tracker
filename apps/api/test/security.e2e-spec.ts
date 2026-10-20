import { createHmac } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma.service';

/**
 * Auth hardening, from the documented contract: every endpoint except
 * /health and the /auth entry points needs a Bearer access token (15 min,
 * signed with JWT_SECRET); the refresh token is an opaque 30-day httpOnly,
 * SameSite=Lax cookie; and nothing about a password ever leaves the API.
 */
describe('Security (e2e)', () => {
  let app: INestApplication<App>;
  let http: App;

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
  });

  afterAll(async () => {
    await app.close();
  });

  const PASSWORD = 'password123';
  const register = async (email = 'sec@example.com') => {
    const res = await request(http)
      .post('/auth/register')
      .send({ email, password: PASSWORD })
      .expect(201);
    return res as request.Response & {
      body: { accessToken: string; user: { id: string } };
    };
  };
  const me = (authorization: string) =>
    request(http).get('/auth/me').set('Authorization', authorization);

  // --- JWT helpers: take a real token apart and put it back together ---
  const b64url = (v: unknown) =>
    Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString(
      'base64url',
    );
  const decode = (token: string) => {
    const [h, p] = token.split('.');
    return {
      header: JSON.parse(Buffer.from(h, 'base64url').toString()) as Record<
        string,
        unknown
      >,
      payload: JSON.parse(Buffer.from(p, 'base64url').toString()) as Record<
        string,
        unknown
      >,
    };
  };
  const sign = (
    header: Record<string, unknown>,
    payload: Record<string, unknown>,
    secret: string,
  ) => {
    const algo = { HS256: 'sha256', HS384: 'sha384', HS512: 'sha512' }[
      String(header.alg)
    ];
    if (!algo) throw new Error(`unexpected JWT alg ${String(header.alg)}`);
    const body = `${b64url(header)}.${b64url(payload)}`;
    return `${body}.${createHmac(algo, secret).update(body).digest('base64url')}`;
  };
  const SECRET = process.env.JWT_SECRET as string;

  describe('every route but the public ones needs a token', () => {
    const PUBLIC = new Set([
      'GET /health',
      'GET /auth/registration',
      'POST /auth/register',
      'POST /auth/login',
      'POST /auth/refresh',
      'POST /auth/logout',
    ]);

    /** Every route the running app actually serves. */
    const routes = (): string[] => {
      const instance = app.getHttpAdapter().getInstance() as {
        router?: { stack: unknown[] };
        _router?: { stack: unknown[] };
      };
      const stack = (instance.router ?? instance._router)?.stack ?? [];
      const out: string[] = [];
      for (const layer of stack as {
        route?: { path: string; methods: Record<string, boolean> };
      }[]) {
        if (!layer.route) continue;
        for (const m of Object.keys(layer.route.methods)) {
          if (['get', 'post', 'put', 'patch', 'delete'].includes(m)) {
            out.push(`${m.toUpperCase()} ${layer.route.path}`);
          }
        }
      }
      return out;
    };
    const send = (route: string, authorization?: string) => {
      const [method, path] = route.split(' ');
      const url = path.replace(/:\w+/g, '00000000-0000-0000-0000-000000000000');
      const req =
        request(http)[
          method.toLowerCase() as 'get' | 'post' | 'put' | 'patch' | 'delete'
        ](url);
      return authorization ? req.set('Authorization', authorization) : req;
    };
    const isDocs = (route: string) => / \/docs/.test(route);

    it('finds the whole API, so the sweep cannot pass by finding nothing', () => {
      const found = routes();
      expect(found.length).toBeGreaterThan(80);
      for (const r of PUBLIC) expect(found).toContain(r);
    });

    it('answers 401 to an anonymous call on every non-public route', async () => {
      const open: string[] = [];
      for (const route of routes()) {
        if (PUBLIC.has(route) || isDocs(route)) continue;
        const res = await send(route);
        if (res.status !== 401) open.push(`${route} → ${res.status}`);
      }
      expect(open).toEqual([]);
    });

    it('answers 401 to a garbage token on every non-public route', async () => {
      const open: string[] = [];
      for (const route of routes()) {
        if (PUBLIC.has(route) || isDocs(route)) continue;
        const res = await send(route, 'Bearer not.a.jwt');
        if (res.status !== 401) open.push(`${route} → ${res.status}`);
      }
      expect(open).toEqual([]);
    });
  });

  describe('access tokens', () => {
    it('lives 15 minutes', async () => {
      const { payload } = decode((await register()).body.accessToken);
      expect(Number(payload.exp) - Number(payload.iat)).toBe(15 * 60);
    });

    it('accepts a token re-signed with the real secret (control)', async () => {
      const { header, payload } = decode((await register()).body.accessToken);
      await me(`Bearer ${sign(header, payload, SECRET)}`).expect(200);
    });

    it('rejects a token signed with any other secret', async () => {
      const { header, payload } = decode((await register()).body.accessToken);
      await me(`Bearer ${sign(header, payload, 'not-the-secret')}`).expect(401);
    });

    it('rejects a token whose payload was edited after signing', async () => {
      const alice = await register('alice@example.com');
      const bob = await register('bob@example.com');
      const [h, , sig] = alice.body.accessToken.split('.');
      const { payload } = decode(alice.body.accessToken);
      // Point every claim that carries Alice's id at Bob instead.
      const forged = Object.fromEntries(
        Object.entries(payload).map(([k, v]) => [
          k,
          v === alice.body.user.id ? bob.body.user.id : v,
        ]),
      );
      expect(forged).not.toEqual(payload);
      await me(`Bearer ${h}.${b64url(forged)}.${sig}`).expect(401);
    });

    it('rejects an unsigned (alg: none) token', async () => {
      const { payload } = decode((await register()).body.accessToken);
      const none = `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url(payload)}.`;
      await me(`Bearer ${none}`).expect(401);
    });

    it('rejects an expired token, even one signed with the real secret', async () => {
      const { header, payload } = decode((await register()).body.accessToken);
      const now = Math.floor(Date.now() / 1000);
      const expired = { ...payload, iat: now - 3600, exp: now - 60 };
      await me(`Bearer ${sign(header, expired, SECRET)}`).expect(401);
    });

    it('needs the Bearer scheme', async () => {
      const { accessToken } = (await register()).body;
      await me(accessToken).expect(401);
      await me(`Basic ${accessToken}`).expect(401);
    });

    it('does not accept the refresh token in its place', async () => {
      const res = await register();
      const cookie = (res.headers['set-cookie'] as unknown as string[]).find(
        (c) => c.startsWith('refresh_token='),
      ) as string;
      const refresh = cookie.split(';')[0].split('=')[1];
      await me(`Bearer ${refresh}`).expect(401);
    });
  });

  describe('the refresh cookie', () => {
    const cookieOf = async () =>
      ((await register()).headers['set-cookie'] as unknown as string[]).find(
        (c) => c.startsWith('refresh_token='),
      ) as string;

    it('is httpOnly and SameSite=Lax', async () => {
      const cookie = await cookieOf();
      expect(cookie).toMatch(/;\s*HttpOnly/i);
      expect(cookie).toMatch(/;\s*SameSite=Lax/i);
    });

    it('lasts 30 days', async () => {
      const cookie = await cookieOf();
      const maxAge = /Max-Age=(\d+)/i.exec(cookie)?.[1];
      const expires = /Expires=([^;]+)/i.exec(cookie)?.[1];
      const seconds = maxAge
        ? Number(maxAge)
        : (Date.parse(expires as string) - Date.now()) / 1000;
      expect(Math.abs(seconds - 30 * 24 * 3600)).toBeLessThan(120);
    });

    it('is refused when an access token is sent in its place', async () => {
      const { accessToken } = (await register()).body;
      await request(http)
        .post('/auth/refresh')
        .set('Cookie', `refresh_token=${accessToken}`)
        .expect(401);
    });
  });

  describe('login', () => {
    it('says the same thing for a wrong password and an unknown email', async () => {
      await register('known@example.com');
      const wrongPassword = await request(http)
        .post('/auth/login')
        .send({ email: 'known@example.com', password: 'wrong-password' });
      const unknownEmail = await request(http)
        .post('/auth/login')
        .send({ email: 'unknown@example.com', password: 'wrong-password' });
      expect(wrongPassword.status).toBe(401);
      expect(unknownEmail.status).toBe(wrongPassword.status);
      expect(unknownEmail.body).toEqual(wrongPassword.body);
    });

    it('treats the email case-insensitively, as registration does', async () => {
      await register('mixed@example.com');
      await request(http)
        .post('/auth/login')
        .send({ email: 'MIXED@Example.com', password: PASSWORD })
        .expect(200);
    });
  });

  describe('registration input', () => {
    it('rejects a malformed email', async () => {
      await request(http)
        .post('/auth/register')
        .send({ email: 'not-an-email', password: PASSWORD })
        .expect(400);
    });

    it('honours a requested base currency, and rejects a malformed one', async () => {
      const res = await request(http)
        .post('/auth/register')
        .send({
          email: 'usd@example.com',
          password: PASSWORD,
          baseCurrency: 'USD',
        })
        .expect(201);
      expect(res.body).toMatchObject({ user: { baseCurrency: 'USD' } });
      await request(http)
        .post('/auth/register')
        .send({
          email: 'bad@example.com',
          password: PASSWORD,
          baseCurrency: 'dollars',
        })
        .expect(400);
    });
  });

  it('never sends a password hash, on any auth response', async () => {
    const registered = await register();
    const bearer = `Bearer ${registered.body.accessToken}`;
    const cookie = (
      registered.headers['set-cookie'] as unknown as string[]
    ).find((c) => c.startsWith('refresh_token=')) as string;
    const responses = [
      registered,
      await request(http)
        .post('/auth/login')
        .send({ email: 'sec@example.com', password: PASSWORD }),
      await me(bearer),
      await request(http)
        .patch('/auth/me')
        .set('Authorization', bearer)
        .send({ baseCurrency: 'EUR' }),
      await request(http).post('/auth/refresh').set('Cookie', cookie),
    ];
    for (const res of responses) {
      expect(res.status).toBeLessThan(300);
      expect(res.text).not.toMatch(/passwordHash|\$argon2/);
    }
  });
});
