/**
 * Copies one user's subcategory list onto a fresh user.
 *
 * For benchmarking a categorizer on a clean slate. Registering gives a new user
 * the 17 seeded defaults, but categorization accuracy depends heavily on how
 * many categories the model is choosing between — measured on this project, the
 * same model went from unusable against 61 to 5-of-6 against 19. So a fresh
 * login measures an easier task than the real system, and its numbers do not
 * transfer. Cloning the real list makes the two comparable, while the new user
 * still has no learned rules of its own.
 *
 *   pnpm -C apps/api clone-categories <source-email> <target-email>
 *
 * Refuses to touch a target whose categories are referenced by anything —
 * transactions, rules, budgets, recurring rules or import rows. This deletes the
 * target's existing subcategories before copying, and that is only safe on a
 * user that has not started using them.
 */
import { PrismaClient } from '@prisma/client';

async function main(): Promise<void> {
  const [sourceEmail, targetEmail] = process.argv.slice(2);
  if (!sourceEmail || !targetEmail) {
    throw new Error(
      'Usage: clone-categories <source-email> <target-email>\n' +
        '  source: the account whose category list you want\n' +
        '  target: a freshly registered account to copy it onto',
    );
  }
  if (sourceEmail.trim().toLowerCase() === targetEmail.trim().toLowerCase()) {
    throw new Error('Source and target are the same user');
  }

  const prisma = new PrismaClient();
  try {
    const find = async (email: string) => {
      const normalized = email.trim().toLowerCase();
      const user = await prisma.user.findUnique({
        where: { email: normalized },
        select: { id: true, email: true },
      });
      if (!user) throw new Error(`No user with email ${normalized}`);
      return user;
    };
    const source = await find(sourceEmail);
    const target = await find(targetEmail);

    const categories = await prisma.subcategory.findMany({
      where: { userId: source.id },
      select: { name: true, category: true, pinned: true },
      orderBy: { name: 'asc' },
    });
    if (categories.length === 0) {
      throw new Error(`${source.email} has no subcategories to copy`);
    }

    // The delete below is the dangerous part, so it is gated on the target's
    // categories being genuinely untouched rather than on the caller's word.
    const inUse = await prisma.subcategory.count({
      where: {
        userId: target.id,
        OR: [
          { transactions: { some: {} } },
          { rules: { some: {} } },
          { budgets: { some: {} } },
          { recurringRules: { some: {} } },
          { chosenImportRows: { some: {} } },
          { predictedImportRows: { some: {} } },
        ],
      },
    });
    if (inUse > 0) {
      throw new Error(
        `${target.email} already uses ${inUse} of its categories — refusing to ` +
          'replace them. Clone onto a freshly registered account instead.',
      );
    }

    // One transaction: a target left with neither its defaults nor the clone
    // would be a login that cannot categorize anything.
    const [{ count: removed }] = await prisma.$transaction([
      prisma.subcategory.deleteMany({ where: { userId: target.id } }),
      prisma.subcategory.createMany({
        data: categories.map((c) => ({ ...c, userId: target.id })),
      }),
    ]);

    console.log(
      `Replaced ${removed} categories on ${target.email} with ${categories.length} copied from ${source.email}.\n` +
        'No rules, accounts or transactions were copied — add an account in the ' +
        'app before importing.',
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
