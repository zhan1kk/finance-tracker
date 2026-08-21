import { Module } from '@nestjs/common';
import { InsightSummaryService } from './insight-summary.service';
import { TransactionController } from './transaction.controller';
import { TransactionStatsService } from './transaction-stats.service';
import { TransactionService } from './transaction.service';

@Module({
  controllers: [TransactionController],
  providers: [
    TransactionService,
    TransactionStatsService,
    InsightSummaryService,
  ],
  exports: [TransactionService],
})
export class TransactionModule {}
