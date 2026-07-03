import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { TEST_DATABASE_URL } from './test-database';

// Creates the test database (if missing) and syncs it to the Prisma schema.
export default function globalSetup(): void {
  execSync('pnpm exec prisma db push --skip-generate --accept-data-loss', {
    cwd: join(__dirname, '..'),
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
    stdio: 'inherit',
  });
}
