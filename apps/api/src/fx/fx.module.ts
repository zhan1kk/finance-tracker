import { Global, Module } from '@nestjs/common';
import { FxController } from './fx.controller';
import { FxSyncScheduler } from './fx-sync.scheduler';
import { FxService } from './fx.service';

/**
 * Global so every module that creates or aggregates transactions can inject
 * FxService without a web of imports. It depends only on the (global) Prisma
 * service, so there is no circular-dependency risk.
 */
@Global()
@Module({
  controllers: [FxController],
  providers: [FxService, FxSyncScheduler],
  exports: [FxService],
})
export class FxModule {}
