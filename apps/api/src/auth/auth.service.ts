import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { createHash, randomBytes } from 'node:crypto';
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
  ) {}

  async register(input: {
    email: string;
    password: string;
    baseCurrency?: string;
  }): Promise<{ user: PublicUser; tokens: AuthTokens }> {
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
    input: { monthStartDay?: number },
  ): Promise<PublicUser> {
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: { monthStartDay: input.monthStartDay },
    });
    return this.toPublicUser(user);
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
