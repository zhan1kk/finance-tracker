import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { REFRESH_COOKIE, REFRESH_COOKIE_PATH } from './auth.constants';
import { AuthService } from './auth.service';
import { CurrentUser } from './decorators/current-user.decorator';
import { Public } from './decorators/public.decorator';
import { ChangePasswordDTO } from './dtos/change-password.dto';
import { LoginDTO } from './dtos/login.dto';
import { RegisterDTO } from './dtos/register.dto';
import { UpdateProfileDTO } from './dtos/update-profile.dto';
import type { AuthTokens, AuthUser } from './types/auth.types';

// Rate-limited per IP: these routes accept credentials, so they are the
// brute-force surface. Limits come from ThrottlerModule in AppModule.
@UseGuards(ThrottlerGuard)
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Get('registration')
  registrationPolicy() {
    return this.authService.registrationPolicy();
  }

  @Public()
  @Post('register')
  async register(
    @Body() body: RegisterDTO,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { user, tokens } = await this.authService.register(body);
    this.setRefreshCookie(res, tokens);
    return { accessToken: tokens.accessToken, user };
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() body: LoginDTO,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { user, tokens } = await this.authService.login(
      body.email,
      body.password,
    );
    this.setRefreshCookie(res, tokens);
    return { accessToken: tokens.accessToken, user };
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { user, tokens } = await this.authService.refresh(
      this.readRefreshCookie(req),
    );
    this.setRefreshCookie(res, tokens);
    return { accessToken: tokens.accessToken, user };
  }

  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.authService.logout(this.readRefreshCookie(req));
    res.clearCookie(REFRESH_COOKIE, { path: REFRESH_COOKIE_PATH });
  }

  @Get('me')
  getMe(@CurrentUser() user: AuthUser) {
    return this.authService.getProfile(user.userId);
  }

  @Patch('me')
  updateMe(@CurrentUser() user: AuthUser, @Body() body: UpdateProfileDTO) {
    return this.authService.updateProfile(user.userId, body);
  }

  /** Changes the caller's password and signs every session out, this one too. */
  @Post('password')
  @HttpCode(HttpStatus.NO_CONTENT)
  async changePassword(
    @CurrentUser() user: AuthUser,
    @Body() body: ChangePasswordDTO,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.authService.changePassword(user.userId, body);
    res.clearCookie(REFRESH_COOKIE, { path: REFRESH_COOKIE_PATH });
  }

  private readRefreshCookie(req: Request): string | undefined {
    const cookies = req.cookies as Record<string, string | undefined>;
    return cookies?.[REFRESH_COOKIE];
  }

  private setRefreshCookie(res: Response, tokens: AuthTokens): void {
    res.cookie(REFRESH_COOKIE, tokens.refreshToken, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: REFRESH_COOKIE_PATH,
      expires: tokens.refreshExpiresAt,
    });
  }
}
