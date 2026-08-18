import { Module } from '@nestjs/common';
import { JobsModule } from '../jobs/jobs.module';
import { TelegramModule } from '../telegram/telegram.module';
import { TransactionModule } from '../transactions/transaction.module';
import { ReminderController } from './reminder.controller';
import { ReminderExtractionService } from './reminder-extraction.service';
import { ReminderPingService } from './reminder-ping.service';
import { ReminderService } from './reminder.service';

@Module({
  imports: [JobsModule, TransactionModule, TelegramModule],
  controllers: [ReminderController],
  providers: [ReminderService, ReminderExtractionService, ReminderPingService],
})
export class ReminderModule {}
