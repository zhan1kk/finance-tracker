import { Module, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_PIPE } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { AppController } from './app.controller';
import { PrismaModule } from './prisma.module';
import { AuthModule } from './auth/auth.module';
import { AccountModule } from './accounts/account.module';
import { TransactionModule } from './transactions/transaction.module';
import { SubcategoryModule } from './subcategories/subcategory.module';
import { TelegramModule } from './telegram/telegram.module';
import { ImportsModule } from './imports/imports.module';
import { RecurringModule } from './recurring/recurring.module';
import { BudgetModule } from './budgets/budget.module';
import { ReportsModule } from './reports/reports.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    PrismaModule,
    AuthModule,
    AccountModule,
    TransactionModule,
    SubcategoryModule,
    TelegramModule,
    ImportsModule,
    RecurringModule,
    BudgetModule,
    ReportsModule,
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
