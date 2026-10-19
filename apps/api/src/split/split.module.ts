import { Module } from '@nestjs/common';
import { SplitController } from './split.controller';
import { SplitGroupsService } from './split-groups.service';
import { SplitService } from './split.service';

@Module({
  controllers: [SplitController],
  providers: [SplitService, SplitGroupsService],
})
export class SplitModule {}
