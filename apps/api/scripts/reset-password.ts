/**
 * Admin password reset, for when someone is locked out and cannot use the
 * in-app "change password" form (which needs the current one).
 *
 * There is no self-service "forgot password" email flow: this deployment has no
 * mail sender, and for a handful of invited users an admin reset over SSH is
 * both simpler and less attack surface. Run it on the server:
 *
 *   cd /opt/finance-tracker
 *   docker compose --profile prod exec api pnpm reset-password <email> '<new password>'
 *
 * Or locally against the dev database:
 *
 *   pnpm -C apps/api reset-password <email> '<new password>'
 *
 * Every existing session for that user is revoked, so a stolen session cannot
 * outlive the reset. Tell the user to change it again once they are back in.
 */
import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';

const MIN_PASSWORD_LENGTH = 8;

async function main(): Promise<void> {
  const [email, newPassword] = process.argv.slice(2);
  if (!email || !newPassword) {
    throw new Error(
      "Usage: reset-password <email> '<new password>' (quote the password)",
    );
  }
  if (newPassword.length < MIN_PASSWORD_LENGTH) {
    throw new Error(
      `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
    );
  }

  const prisma = new PrismaClient();
  try {
    const normalized = email.trim().toLowerCase();
    const user = await prisma.user.findUnique({ where: { email: normalized } });
    if (!user) {
      throw new Error(`No user with email ${normalized}`);
    }
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await argon2.hash(newPassword) },
    });
    const { count } = await prisma.refreshToken.deleteMany({
      where: { userId: user.id },
    });
    console.log(
      `Password reset for ${normalized}; ${count} active session(s) revoked.`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
