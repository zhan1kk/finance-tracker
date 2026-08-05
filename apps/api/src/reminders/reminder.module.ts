import { Module } from '@nestjs/common';
import { JobsModule } from '../jobs/jobs.module';
import { TransactionModule } from '../transactions/transaction.module';
import { ReminderController } from './reminder.controller';
import { ReminderExtractionService } from './reminder-extraction.service';
import { ReminderService } from './reminder.service';

@Module({
  imports: [JobsModule, TransactionModule],
  controllers: [ReminderController],
  providers: [ReminderService, ReminderExtractionService],
})
export class ReminderModule {}
