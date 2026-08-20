import { Module, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_PIPE } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule } from '@nestjs/throttler';
import { AppController } from './app.controller';
import { validateEnv } from './config/env.validation';
import { PrismaModule } from './prisma.module';
import { FxModule } from './fx/fx.module';
import { AuthModule } from './auth/auth.module';
import { AccountModule } from './accounts/account.module';
import { TransactionModule } from './transactions/transaction.module';
import { SubcategoryModule } from './subcategories/subcategory.module';
import { TelegramModule } from './telegram/telegram.module';
import { ImportsModule } from './imports/imports.module';
import { RecurringModule } from './recurring/recurring.module';
import { BudgetModule } from './budgets/budget.module';
import { ReportsModule } from './reports/reports.module';
import { ReminderModule } from './reminders/reminder.module';
import { JobsModule } from './jobs/jobs.module';
import { SplitModule } from './split/split.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    // Rate-limit budget; enforced only where a ThrottlerGuard is applied
    // (the auth controller). Effectively unlimited under jest.
    ThrottlerModule.forRoot([
      {
        ttl: 60_000,
        limit: process.env.NODE_ENV === 'test' ? 10_000 : 20,
      },
    ]),
    // Not under jest: the suite drives time-sensitive flows and tears the app
    // down repeatedly, and background timers have nothing to contribute there
    // except a source of non-determinism. @Cron methods simply go unregistered.
    ...(process.env.NODE_ENV === 'test' ? [] : [ScheduleModule.forRoot()]),
    PrismaModule,
    FxModule,
    AuthModule,
    AccountModule,
    TransactionModule,
    SubcategoryModule,
    TelegramModule,
    ImportsModule,
    RecurringModule,
    BudgetModule,
    ReportsModule,
    ReminderModule,
    JobsModule,
    SplitModule,
  ],
  controllers: [AppController],
  providers: [
    {
      provide: APP_PIPE,
      useValue: new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    },
  ],
})
export class AppModule {}
