import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { optionalSetting } from '../common/env';
import { BASE_CURRENCY } from '../fx/fx';
import { FxService } from '../fx/fx.service';
import { PrismaService } from '../prisma.service';
import { DEFAULT_SUBCATEGORIES } from '../subcategories/default-subcategories';
import { REFRESH_TOKEN_TTL_DAYS } from './auth.constants';
import type { AuthTokens, JwtPayload } from './types/auth.types';

type PublicUser = {
  id: string;
  email: string;
  baseCurrency: string;
  monthStartDay: number;
};

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
    private readonly fx: FxService,
  ) {}

  /**
   * Whether this deployment gates registration behind an invite code.
   *
   * The form used to hedge — "Invite code (if you were given one)" — which is
   * wrong in both directions: on an invite-only deployment the field is
   * mandatory and reads as optional, and on a self-hosted one with no code set
   * it is dead weight the user has nothing to type into. Public because it is
   * read before anyone can authenticate, and it discloses nothing beyond what
   * attempting to register already tells you.
   */
  registrationPolicy(): { inviteRequired: boolean } {
    return {
      inviteRequired: Boolean(optionalSetting(this.config, 'INVITE_CODE')),
    };
  }

  async register(input: {
    email: string;
    password: string;
    baseCurrency?: string;
    inviteCode?: string;
  }): Promise<{ user: PublicUser; tokens: AuthTokens }> {
    // With INVITE_CODE set, registration is invite-only. Digest comparison
    // keeps it constant-time even when the lengths differ.
    //
    // Read through optionalSetting: compose passes this as `${INVITE_CODE:-}`,
    // so an unset variable arrives as `''` — and a falsy code here does not fail
    // closed, it removes the gate entirely and opens registration to anyone.
    // Trimming also stops a stray space in .env from becoming the real code.
    const requiredCode = optionalSetting(this.config, 'INVITE_CODE');
    if (requiredCode) {
      const supplied = createHash('sha256')
        .update(input.inviteCode?.trim() ?? '')
        .digest();
      const expected = createHash('sha256').update(requiredCode).digest();
      if (!timingSafeEqual(supplied, expected)) {
        throw new ForbiddenException(
          'A valid invite code is required to register',
        );
      }
    }

    const email = input.email.trim().toLowerCase();

    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) {
      throw new ConflictException(`User with email ${email} already exists`);
    }

    const passwordHash = await argon2.hash(input.password);

    const user = await this.prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: { email, passwordHash, baseCurrency: input.baseCurrency },
      });
      await tx.subcategory.createMany({
        data: DEFAULT_SUBCATEGORIES.map((subcategory) => ({
          ...subcategory,
          userId: created.id,
        })),
      });
      // Start with a cash wallet: everyone has one, it is what the Telegram
      // capture bot books against, and it means the app is usable before the
      // first statement import. An ordinary account — rename or delete it.
      await tx.account.create({
        data: {
          userId: created.id,
          name: 'Cash',
          type: 'cash',
          currency: created.baseCurrency,
        },
      });
      return created;
    });

    const tokens = await this.issueTokens(user.id, user.email);
    return { user: this.toPublicUser(user), tokens };
  }

  async login(
    email: string,
    password: string,
  ): Promise<{ user: PublicUser; tokens: AuthTokens }> {
    const user = await this.prisma.user.findUnique({
      where: { email: email.trim().toLowerCase() },
    });

    if (!user || !(await argon2.verify(user.passwordHash, password))) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const tokens = await this.issueTokens(user.id, user.email);
    return { user: this.toPublicUser(user), tokens };
  }

  /** Rotates the refresh token: the presented token is consumed, a new one issued. */
  async refresh(
    refreshToken: string | undefined,
  ): Promise<{ user: PublicUser; tokens: AuthTokens }> {
    if (!refreshToken) {
      throw new UnauthorizedException('Missing refresh token');
    }

    const tokenHash = this.hashToken(refreshToken);
    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    });

    if (!stored) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    await this.prisma.refreshToken.delete({ where: { id: stored.id } });

    if (stored.expiresAt < new Date()) {
      throw new UnauthorizedException('Refresh token expired');
    }

    const tokens = await this.issueTokens(stored.user.id, stored.user.email);
    return { user: this.toPublicUser(stored.user), tokens };
  }

  /** Revokes the presented refresh token. Idempotent. */
  async logout(refreshToken: string | undefined): Promise<void> {
    if (!refreshToken) {
      return;
    }
    await this.prisma.refreshToken.deleteMany({
      where: { tokenHash: this.hashToken(refreshToken) },
    });
  }

  async getProfile(userId: string): Promise<PublicUser> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User not found');
    }
    return this.toPublicUser(user);
  }

  /** Updates the caller's own reporting preferences. */
  async updateProfile(
    userId: string,
    input: { monthStartDay?: number; baseCurrency?: string },
  ): Promise<PublicUser> {
    // Proven before it is stored, by actually obtaining a rate for it. The
    // field used to be settable only at registration and nothing checked it,
    // while every total was computed in EUR regardless — so a user who picked
    // USD got euro figures wearing a dollar sign, which is the worst thing a
    // money app can do quietly. A currency with no obtainable rate is refused
    // here rather than falling through to a seed value later.
    if (input.baseCurrency && input.baseCurrency !== BASE_CURRENCY) {
      try {
        await this.fx.displayRate(userId, input.baseCurrency);
      } catch {
        throw new BadRequestException(
          `No exchange rate is available for ${input.baseCurrency}`,
        );
      }
    }
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: {
        monthStartDay: input.monthStartDay,
        baseCurrency: input.baseCurrency,
      },
    });
    return this.toPublicUser(user);
  }

  /**
   * Changes the caller's password after re-checking the current one, then drops
   * every refresh token they hold: if the reason for changing it was that
   * someone else had the old password, their session must not survive it. The
   * caller signs in again with the new password.
   */
  async changePassword(
    userId: string,
    input: { currentPassword: string; newPassword: string },
  ): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User not found');
    }
    const valid = await argon2.verify(user.passwordHash, input.currentPassword);
    if (!valid) {
      throw new UnauthorizedException('Current password is incorrect');
    }
    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash: await argon2.hash(input.newPassword) },
    });
    await this.prisma.refreshToken.deleteMany({ where: { userId } });
  }

  private async issueTokens(
    userId: string,
    email: string,
  ): Promise<AuthTokens> {
    const payload: JwtPayload = { sub: userId, email };
    const accessToken = await this.jwtService.signAsync(payload);

    const refreshToken = randomBytes(48).toString('base64url');
    const refreshExpiresAt = new Date(
      Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
    );

    await this.prisma.refreshToken.create({
      data: {
        tokenHash: this.hashToken(refreshToken),
        expiresAt: refreshExpiresAt,
        userId,
      },
    });
    // Housekeeping: drop this user's expired tokens.
    await this.prisma.refreshToken.deleteMany({
      where: { userId, expiresAt: { lt: new Date() } },
    });

    return { accessToken, refreshToken, refreshExpiresAt };
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private toPublicUser(user: {
    id: string;
    email: string;
    baseCurrency: string;
    monthStartDay: number;
  }): PublicUser {
    return {
      id: user.id,
      email: user.email,
      baseCurrency: user.baseCurrency,
      monthStartDay: user.monthStartDay,
    };
  }
}
