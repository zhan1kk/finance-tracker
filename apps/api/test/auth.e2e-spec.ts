import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma.service';

describe('Auth (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let http: App;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication({ bodyParser: false });
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    http = app.getHttpServer();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE "Transaction", "Account", "Subcategory", "RefreshToken", "User" CASCADE',
    );
  });

  afterAll(async () => {
    await app.close();
  });

  const CREDENTIALS = { email: 'alice@example.com', password: 'password123' };

  const register = () =>
    request(http).post('/auth/register').send(CREDENTIALS).expect(201);

  const refreshCookieOf = (res: request.Response): string => {
    const cookies = res.headers['set-cookie'] as unknown as string[];
    const cookie = cookies?.find((c) => c.startsWith('refresh_token='));
    expect(cookie).toBeDefined();
    return cookie as string;
  };

  describe('register', () => {
    it('returns an access token, the user, and a refresh cookie', async () => {
      const res = await register();
      expect(res.body).toMatchObject({
        accessToken: expect.any(String) as unknown,
        user: { email: CREDENTIALS.email, baseCurrency: 'EUR' },
      });
      expect(res.body).not.toHaveProperty('user.passwordHash');
      expect(refreshCookieOf(res)).toContain('HttpOnly');
    });

    it('seeds default subcategories for the new user', async () => {
      const token = (await register()).body.accessToken as string;
      const res = await request(http)
        .get('/subcategories')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect((res.body as unknown[]).length).toBeGreaterThanOrEqual(10);
    });

    it('rejects a duplicate email (case-insensitive)', async () => {
      await register();
      await request(http)
        .post('/auth/register')
        .send({ ...CREDENTIALS, email: 'ALICE@example.com' })
        .expect(409);
    });

    it('rejects a short password', async () => {
      await request(http)
        .post('/auth/register')
        .send({ email: 'bob@example.com', password: 'short' })
        .expect(400);
    });
  });

  describe('login', () => {
    beforeEach(register);

    it('succeeds with correct credentials', async () => {
      const res = await request(http)
        .post('/auth/login')
        .send(CREDENTIALS)
        .expect(200);
      expect(res.body).toHaveProperty('accessToken');
      refreshCookieOf(res);
    });

    it('rejects a wrong password', async () => {
      await request(http)
        .post('/auth/login')
        .send({ ...CREDENTIALS, password: 'wrong-password' })
        .expect(401);
    });

    it('rejects an unknown email', async () => {
      await request(http)
        .post('/auth/login')
        .send({ email: 'nobody@example.com', password: 'password123' })
        .expect(401);
    });
  });

  describe('protected routes', () => {
    it('rejects requests without a token', async () => {
      await request(http).get('/accounts').expect(401);
      await request(http).get('/auth/me').expect(401);
    });

    it('rejects a garbage token', async () => {
      await request(http)
        .get('/accounts')
        .set('Authorization', 'Bearer not-a-jwt')
        .expect(401);
    });

    it('keeps /health public', async () => {
      await request(http).get('/health').expect(200);
    });

    it('returns the profile on /auth/me', async () => {
      const token = (await register()).body.accessToken as string;
      const res = await request(http)
        .get('/auth/me')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(res.body).toMatchObject({ email: CREDENTIALS.email });
    });
  });

  describe('refresh & logout', () => {
    it('issues a new access token and rotates the refresh token', async () => {
      const cookie = refreshCookieOf(await register());

      const first = await request(http)
        .post('/auth/refresh')
        .set('Cookie', cookie)
        .expect(200);
      expect(first.body).toHaveProperty('accessToken');

      // The old cookie was consumed by rotation.
      await request(http)
        .post('/auth/refresh')
        .set('Cookie', cookie)
        .expect(401);

      // The rotated cookie works.
      await request(http)
        .post('/auth/refresh')
        .set('Cookie', refreshCookieOf(first))
        .expect(200);
    });

    it('rejects refresh without a cookie', async () => {
      await request(http).post('/auth/refresh').expect(401);
    });

    it('logout revokes the refresh token', async () => {
      const cookie = refreshCookieOf(await register());

      await request(http)
        .post('/auth/logout')
        .set('Cookie', cookie)
        .expect(204);
      await request(http)
        .post('/auth/refresh')
        .set('Cookie', cookie)
        .expect(401);
    });
  });

  describe('change password', () => {
    const NEW_PASSWORD = 'a-much-better-password';

    it('swaps the password, revoking every existing session', async () => {
      const registered = await register();
      const token = (registered.body as { accessToken: string }).accessToken;
      const cookie = refreshCookieOf(registered);

      await request(http)
        .post('/auth/password')
        .set('Authorization', `Bearer ${token}`)
        .send({
          currentPassword: CREDENTIALS.password,
          newPassword: NEW_PASSWORD,
        })
        .expect(204);

      // The old refresh token must not survive a password change.
      await request(http)
        .post('/auth/refresh')
        .set('Cookie', cookie)
        .expect(401);

      await request(http).post('/auth/login').send(CREDENTIALS).expect(401);
      await request(http)
        .post('/auth/login')
        .send({ email: CREDENTIALS.email, password: NEW_PASSWORD })
        .expect(200);
    });

    it('rejects a wrong current password, leaving the old one working', async () => {
      const token = (await register()).body as { accessToken: string };

      await request(http)
        .post('/auth/password')
        .set('Authorization', `Bearer ${token.accessToken}`)
        .send({ currentPassword: 'not-my-password', newPassword: NEW_PASSWORD })
        .expect(401);

      await request(http).post('/auth/login').send(CREDENTIALS).expect(200);
    });

    it('rejects a short new password and unauthenticated callers', async () => {
      const token = (await register()).body as { accessToken: string };

      await request(http)
        .post('/auth/password')
        .set('Authorization', `Bearer ${token.accessToken}`)
        .send({ currentPassword: CREDENTIALS.password, newPassword: 'short' })
        .expect(400);

      await request(http)
        .post('/auth/password')
        .send({
          currentPassword: CREDENTIALS.password,
          newPassword: NEW_PASSWORD,
        })
        .expect(401);
    });
  });
});
