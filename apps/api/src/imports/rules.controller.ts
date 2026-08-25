import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/types/auth.types';
import { CreateRuleDTO } from './dtos/create-rule.dto';
import { BulkCreateRulesDTO, PreviewRulesDTO } from './dtos/preview-rules.dto';
import { UpdateRuleDTO } from './dtos/update-rule.dto';
import { RulesService } from './rules.service';

@Controller('rules')
export class RulesController {
  constructor(private readonly rulesService: RulesService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.rulesService.list(user.userId);
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() body: CreateRuleDTO) {
    return this.rulesService.create(user.userId, body);
  }

  /** Dry run: what each candidate pattern would match. Creates nothing. */
  @Post('preview')
  preview(@CurrentUser() user: AuthUser, @Body() body: PreviewRulesDTO) {
    return this.rulesService.preview(user.userId, body.patterns);
  }

  @Post('bulk')
  createMany(@CurrentUser() user: AuthUser, @Body() body: BulkCreateRulesDTO) {
    return this.rulesService.createMany(user.userId, body.rules);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() body: UpdateRuleDTO,
  ) {
    return this.rulesService.update(user.userId, id, body);
  }

  @Delete(':id')
  async remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    await this.rulesService.remove(user.userId, id);
    return { deleted: true };
  }
}
