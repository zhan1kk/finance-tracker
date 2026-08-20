import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/types/auth.types';
import { SetRateDTO } from './dtos/set-rate.dto';
import { AddCurrencyDTO, SetAutoSyncDTO } from './dtos/currency.dto';
import { SetSpreadDTO } from './dtos/set-spread.dto';
import { SyncRateDTO } from './dtos/sync-rate.dto';
import { FxService } from './fx.service';

@Controller('fx')
export class FxController {
  constructor(private readonly fx: FxService) {}

  /** Rates + effective-today rate for a currency (e.g. ?currency=KZT). */
  @Get('rates')
  listRates(@CurrentUser() user: AuthUser, @Query('currency') currency?: string) {
    if (!currency || !/^[A-Z]{3}$/.test(currency)) {
      throw new BadRequestException('currency query param (3-letter code) is required');
    }
    return this.fx.listRates(user.userId, currency);
  }

  @Post('rates')
  setRate(@CurrentUser() user: AuthUser, @Body() body: SetRateDTO) {
    return this.fx.setRate(user.userId, body.currency, body.date, body.rate);
  }

  /** Fetch today's market rate for a currency, apply its spread, and store it. */
  @Post('rates/sync')
  syncRate(@CurrentUser() user: AuthUser, @Body() body: SyncRateDTO) {
    return this.fx.syncRate(user.userId, body.currency);
  }

  /** The tracked foreign currencies and their exchange-fee spreads. */
  @Get('preferences')
  listPreferences(@CurrentUser() user: AuthUser) {
    return this.fx.listPreferences(user.userId);
  }

  /** Start tracking a currency (fetches its rate so it is usable immediately). */
  @Post('currencies')
  addCurrency(@CurrentUser() user: AuthUser, @Body() body: AddCurrencyDTO) {
    return this.fx.addCurrency(user.userId, body.currency.toUpperCase());
  }

  /** Stop tracking a currency; refused while accounts still use it. */
  @Delete('currencies/:currency')
  removeCurrency(
    @CurrentUser() user: AuthUser,
    @Param('currency') currency: string,
  ) {
    return this.fx.removeCurrency(user.userId, currency.toUpperCase());
  }

  /** Turn the daily rate fetch on or off for one currency. */
  @Put('currencies/:currency/auto-sync')
  setAutoSync(
    @CurrentUser() user: AuthUser,
    @Param('currency') currency: string,
    @Body() body: SetAutoSyncDTO,
  ) {
    return this.fx.setAutoSync(
      user.userId,
      currency.toUpperCase(),
      body.autoSync,
    );
  }

  /** Set the exchange-fee spread (0–10%) for a currency. */
  @Put('preferences/:currency')
  setSpread(
    @CurrentUser() user: AuthUser,
    @Param('currency') currency: string,
    @Body() body: SetSpreadDTO,
  ) {
    return this.fx.setSpread(user.userId, currency.toUpperCase(), body.spreadPct);
  }

  @Delete('rates/:id')
  deleteRate(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.fx.deleteRate(user.userId, id);
  }
}
