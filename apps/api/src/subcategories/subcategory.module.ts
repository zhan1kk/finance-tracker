import { Module } from '@nestjs/common';
import { SubcategoryController } from './subcategory.controller';
import { SubcategoryService } from './subcategory.service';
import { PrismaService } from '../prisma.service';

@Module({
  controllers: [SubcategoryController],
  providers: [SubcategoryService, PrismaService],
  exports: [SubcategoryService],
})
export class SubcategoryModule {}
