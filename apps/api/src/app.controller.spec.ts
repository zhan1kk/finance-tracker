import { Test, TestingModule } from '@nestjs/testing';
import { AppController } from './app.controller';
import { AppService } from './app.service';

describe('AppController', () => {
  let appController: AppController;
  let appService: AppService;

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [AppService],
    }).compile();

    appController = app.get<AppController>(AppController);
    appService = app.get<AppService>(AppService);
  });

  describe('root', () => {
    it('should return "Hello World!"', () => {
      expect(appController.getHello()).toBe('Hello World!');
    });
  });

  describe('analytics', () => {
    it('should return totals from created entries', () => {
      appService.createTransaction({
        transactionDate: '2026-03-27',
        amount: 1000,
        subcategory: 'Salary',
        category: 'Income',
        description: 'Monthly salary',
      });

      appService.createTransaction({
        transactionDate: '2026-03-27',
        amount: 120,
        subcategory: 'Groceries',
        category: 'Expenses',
        description: 'Weekly food',
      });

      expect(appController.getAnalyticsSummary()).toEqual({
        totalSpent: 120,
        totalEarned: 1000,
        balance: 880,
        transactionCount: 2,
      });
    });
  });
});
