import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';

describe('AppController (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  it('/ (GET)', () => {
    return request(app.getHttpServer())
      .get('/')
      .expect(200)
      .expect('Hello World!');
  });

  it('/transactions (POST, GET) and /analytics/summary (GET)', async () => {
    await request(app.getHttpServer())
      .post('/transactions')
      .send({
        transactionDate: '2026-03-27',
        amount: 2000,
        subcategory: 'Salary',
        category: 'Income',
        description: 'Main job salary',
      })
      .expect(201);

    await request(app.getHttpServer())
      .post('/transactions')
      .send({
        transactionDate: '2026-03-27',
        amount: 50,
        subcategory: 'Taxi',
        category: 'Expenses',
        description: 'Ride to office',
      })
      .expect(201);

    await request(app.getHttpServer())
      .get('/transactions')
      .expect(200)
      .expect((res) => {
        expect(res.body).toHaveLength(2);
      });

    await request(app.getHttpServer())
      .get('/analytics/summary')
      .expect(200)
      .expect({
        totalSpent: 50,
        totalEarned: 2000,
        balance: 1950,
        transactionCount: 2,
      });
  });
});
