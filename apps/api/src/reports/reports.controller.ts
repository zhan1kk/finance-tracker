import { Controller, Get, Header, Query } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/types/auth.types';
import { ReportsService } from './reports.service';

@Controller('reports')
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  @Get('net-worth')
  netWorth(@CurrentUser() user: AuthUser, @Query('months') months?: string) {
    const parsed = Number(months);
    const clamped = Number.isFinite(parsed)
      ? Math.min(60, Math.max(1, Math.trunc(parsed)))
      : 12;
    return this.reportsService.netWorth(user.userId, clamped);
  }

  @Get('transactions.csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="transactions.csv"')
  exportCsv(@CurrentUser() user: AuthUser) {
    return this.reportsService.exportTransactionsCsv(user.userId);
  }
}
