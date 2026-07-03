import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { TEST_DATABASE_URL } from './test-database';

// Creates the test database (if missing) and syncs it to the Prisma schema.
// --force-reset drops it first: it is a dedicated, disposable test database.
export default function globalSetup(): void {
  execSync('pnpm exec prisma db push --skip-generate --force-reset', {
    cwd: join(__dirname, '..'),
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
    stdio: 'inherit',
  });
}
