import { Module } from '@nestjs/common';
import { TransactionModule } from '../transactions/transaction.module';
import { TelegramBotService } from './telegram-bot.service';
import { TelegramController } from './telegram.controller';
import { TelegramService } from './telegram.service';

@Module({
  imports: [TransactionModule],
  controllers: [TelegramController],
  providers: [TelegramService, TelegramBotService],
})
export class TelegramModule {}
