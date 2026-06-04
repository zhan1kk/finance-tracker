import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AccountModule } from './accounts/account.module';
import { TransactionModule } from './transactions/transaction.module';
import { SubcategoryModule } from './subcategories/subcategory.module';
import { PrismaService } from './prisma.service';

@Module({
  imports: [AccountModule, TransactionModule, SubcategoryModule],
  controllers: [AppController],
  providers: [AppService, PrismaService],
  exports: [PrismaService],
})
export class AppModule {}
