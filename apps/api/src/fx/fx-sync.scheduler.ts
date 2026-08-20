import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma.service';
import { FxService } from './fx.service';

/**
 * Pulls the day's market rate for currencies the user opted into syncing.
 *
 * Opt-in per currency, and the only outbound call the app makes: it asks a
 * public endpoint for euro reference rates and sends nothing about the user —
 * no account, no amount, not even which currency belongs to whom beyond the
 * code itself. A failure is logged and skipped, never retried in a loop, so a
 * flaky morning cannot hammer the source or hold up the others.
 */
@Injectable()
export class FxSyncScheduler {
  private readonly logger = new Logger(FxSyncScheduler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly fx: FxService,
  ) {}

  // After the reference rates publish, and before the reminder nudges at 09:00.
  @Cron('0 7 * * *')
  async syncOptedIn(): Promise<{ synced: number; failed: number }> {
    const prefs = await this.prisma.currencyPreference.findMany({
      where: { autoSync: true },
      select: { userId: true, currency: true },
    });

    let synced = 0;
    let failed = 0;
    for (const pref of prefs) {
      try {
        await this.fx.syncRate(pref.userId, pref.currency);
        synced++;
      } catch (err: unknown) {
        failed++;
        this.logger.warn(
          `Could not sync ${pref.currency}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (synced > 0 || failed > 0) {
      this.logger.log(`Rate sync: ${synced} updated, ${failed} failed`);
    }
    return { synced, failed };
  }
}
