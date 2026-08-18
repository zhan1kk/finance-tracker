import { Body, Controller, Delete, Get, Patch, Post } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/types/auth.types';
import { UpdateTelegramSettingsDTO } from './dtos/update-telegram-settings.dto';
import { TelegramService } from './telegram.service';

@Controller('telegram')
export class TelegramController {
  constructor(private readonly telegramService: TelegramService) {}

  /** Generates a one-time code to send to the bot as `/link <code>`. */
  @Post('link-code')
  createLinkCode(@CurrentUser() user: AuthUser) {
    return this.telegramService.createLinkCode(user.userId);
  }

  @Get('settings')
  getSettings(@CurrentUser() user: AuthUser) {
    return this.telegramService.getSettings(user.userId);
  }

  @Patch('settings')
  updateSettings(
    @CurrentUser() user: AuthUser,
    @Body() body: UpdateTelegramSettingsDTO,
  ) {
    return this.telegramService.updateSettings(user.userId, body);
  }

  @Delete('link')
  unlink(@CurrentUser() user: AuthUser) {
    return this.telegramService.unlink(user.userId);
  }
}
