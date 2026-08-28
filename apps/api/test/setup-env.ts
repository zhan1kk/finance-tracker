import { TEST_DATABASE_URL } from './test-database';

// Runs before any test module is imported, so PrismaService connects to the
// test database instead of the one in .env.
process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.JWT_SECRET ??= 'e2e-test-secret';

// Categorization must be deterministic and offline in tests: the fixtures
// assert exactly which rows a categorizer resolves vs. flags for review. A
// developer's real .env may set CATEGORIZER=anthropic (or ollama), which would
// call an external model — non-deterministic, slow (timeouts), and billable.
// Force the zero-config heuristic and strip provider creds so nothing reaches
// out, regardless of what .env carries.
//
// Blanked, not deleted. ConfigModule parses .env itself and fills in every key
// process.env is *missing*, so deleting one hands it straight back. That was
// not theoretical: with a key in .env the suite reached the real Anthropic API
// and was answered by it. An empty value survives, and optionalSetting reads
// blank as unset everywhere it matters.
process.env.CATEGORIZER = 'heuristic';
process.env.ANTHROPIC_API_KEY = '';
process.env.OLLAMA_BASE_URL = '';
