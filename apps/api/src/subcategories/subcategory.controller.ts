import {
  Body,
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
} from '@nestjs/common';
import { SubcategoryService } from './subcategory.service';
import { CreateSubcategoryDTO } from './dtos/create-subcategory.dto';

@Controller('subcategories')
export class SubcategoryController {
  constructor(private readonly subcategoryService: SubcategoryService) {}

  @Get()
  listSubcategories() {
    return this.subcategoryService.listSubcategories();
  }

  @Get(':id')
  getSubcategoryById(@Param('id') id: string) {
    return this.subcategoryService.getSubcategoryById(id);
  }

  @Post()
  createSubcategory(@Body() body: CreateSubcategoryDTO) {
    return this.subcategoryService.createSubcategory(body);
  }

  @Patch(':id')
  updateSubcategory(
    @Param('id') id: string,
    @Body() body: Partial<CreateSubcategoryDTO>,
  ) {
    return this.subcategoryService.updateSubcategory(id, body);
  }

  @Delete(':id')
  async deleteSubcategory(@Param('id') id: string) {
    await this.subcategoryService.deleteSubcategory(id);
    return { deleted: true };
  }
}
