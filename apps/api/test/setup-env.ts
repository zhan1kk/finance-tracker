import { TEST_DATABASE_URL } from './test-database';

// Runs before any test module is imported, so PrismaService connects to the
// test database instead of the one in .env.
process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.JWT_SECRET ??= 'e2e-test-secret';
