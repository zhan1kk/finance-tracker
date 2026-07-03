import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';
import { DEFAULT_SUBCATEGORIES } from '../src/subcategories/default-subcategories';

const prisma = new PrismaClient();

const DEMO_EMAIL = 'demo@local.test';
const DEMO_PASSWORD = 'changeme123';

async function main() {
  const user = await prisma.user.upsert({
    where: { email: DEMO_EMAIL },
    update: {},
    create: {
      email: DEMO_EMAIL,
      passwordHash: await argon2.hash(DEMO_PASSWORD),
      baseCurrency: 'EUR',
    },
  });

  for (const subcategory of DEFAULT_SUBCATEGORIES) {
    await prisma.subcategory.upsert({
      where: { userId_name: { userId: user.id, name: subcategory.name } },
      update: {},
      create: { ...subcategory, userId: user.id },
    });
  }

  console.log(
    `Seeded demo user ${DEMO_EMAIL} (password: ${DEMO_PASSWORD}) with ${DEFAULT_SUBCATEGORIES.length} subcategories.`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
