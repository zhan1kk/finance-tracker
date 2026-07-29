import { Module } from '@nestjs/common';
import { TransactionModule } from '../transactions/transaction.module';
import { GuidedCaptureService } from './guided-capture.service';
import { TelegramBotService } from './telegram-bot.service';
import { TelegramController } from './telegram.controller';
import { TelegramService } from './telegram.service';

@Module({
  imports: [TransactionModule],
  controllers: [TelegramController],
  providers: [TelegramService, GuidedCaptureService, TelegramBotService],
})
export class TelegramModule {}
