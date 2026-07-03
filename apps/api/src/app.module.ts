import { Module, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_PIPE } from '@nestjs/core';
import { AppController } from './app.controller';
import { PrismaModule } from './prisma.module';
import { AuthModule } from './auth/auth.module';
import { AccountModule } from './accounts/account.module';
import { TransactionModule } from './transactions/transaction.module';
import { SubcategoryModule } from './subcategories/subcategory.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    AuthModule,
    AccountModule,
    TransactionModule,
    SubcategoryModule,
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
