import {
  Body,
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
} from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/types/auth.types';
import { SubcategoryService } from './subcategory.service';
import { CreateSubcategoryDTO } from './dtos/create-subcategory.dto';
import { UpdateSubcategoryDTO } from './dtos/update-subcategory.dto';

@Controller('subcategories')
export class SubcategoryController {
  constructor(private readonly subcategoryService: SubcategoryService) {}

  @Get()
  listSubcategories(@CurrentUser() user: AuthUser) {
    return this.subcategoryService.listSubcategories(user.userId);
  }

  @Get(':id')
  getSubcategoryById(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.subcategoryService.getSubcategoryById(user.userId, id);
  }

  @Post()
  createSubcategory(
    @CurrentUser() user: AuthUser,
    @Body() body: CreateSubcategoryDTO,
  ) {
    return this.subcategoryService.createSubcategory(user.userId, body);
  }

  @Patch(':id')
  updateSubcategory(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() body: UpdateSubcategoryDTO,
  ) {
    return this.subcategoryService.updateSubcategory(user.userId, id, body);
  }

  @Delete(':id')
  async deleteSubcategory(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ) {
    await this.subcategoryService.deleteSubcategory(user.userId, id);
    return { deleted: true };
  }
}
