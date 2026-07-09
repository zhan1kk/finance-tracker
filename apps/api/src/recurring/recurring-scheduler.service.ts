import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { RecurringService } from './recurring.service';

/** Posts due recurring transactions once a day. The heavy lifting (catch-up,
 * installments, deactivation) lives in RecurringService.runDue. */
@Injectable()
export class RecurringScheduler {
  private readonly logger = new Logger(RecurringScheduler.name);

  constructor(private readonly recurring: RecurringService) {}

  @Cron(CronExpression.EVERY_DAY_AT_6AM)
  async postDue() {
    const { transactionsCreated } = await this.recurring.runDue(new Date());
    if (transactionsCreated > 0) {
      this.logger.log(`Posted ${transactionsCreated} recurring transaction(s)`);
    }
  }
}
