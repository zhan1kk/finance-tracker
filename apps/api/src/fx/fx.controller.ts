import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/types/auth.types';
import { SetRateDTO } from './dtos/set-rate.dto';
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

  @Delete('rates/:id')
  deleteRate(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.fx.deleteRate(user.userId, id);
  }
}
