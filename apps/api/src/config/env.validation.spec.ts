import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateEnv } from './env.validation';

const DATABASE_URL = 'postgresql://u:p@localhost:5432/db';
const STRONG = 'a3f9c27e1b8d4f60e2a7c9b13d5e8f0a4c6b2d9e7f1a3c5b'; // 48 hex chars

/** The value people get when they follow the README: cp .env.example .env */
const exampleSecret = (): string => {
  const env = readFileSync(join(__dirname, '../../.env.example'), 'utf8');
  const match = /^JWT_SECRET\s*=\s*"?([^"\n]*)"?/m.exec(env);
  if (!match) throw new Error('.env.example has no JWT_SECRET line');
  return match[1];
};

describe('validateEnv', () => {
  describe('in every environment', () => {
    it('refuses to boot without a JWT_SECRET', () => {
      expect(() => validateEnv({ DATABASE_URL })).toThrow(/JWT_SECRET/);
      expect(() => validateEnv({ DATABASE_URL, JWT_SECRET: '' })).toThrow(
        /JWT_SECRET/,
      );
    });

    it('refuses a DATABASE_URL that is not a PostgreSQL connection string', () => {
      expect(() => validateEnv({ JWT_SECRET: STRONG })).toThrow(/DATABASE_URL/);
      expect(() =>
        validateEnv({ DATABASE_URL: 'mysql://x/y', JWT_SECRET: STRONG }),
      ).toThrow(/DATABASE_URL/);
    });

    it('reports every problem at once, not just the first', () => {
      expect(() => validateEnv({})).toThrow(/DATABASE_URL[\s\S]*JWT_SECRET/);
    });

    it('never echoes the secret it refused into the error', () => {
      const weak = 'hunter2-is-my-secret';
      let message = '';
      try {
        validateEnv({ NODE_ENV: 'production', DATABASE_URL, JWT_SECRET: weak });
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toMatch(/JWT_SECRET/);
      expect(message).not.toContain(weak);
    });
  });

  describe('outside production', () => {
    it('accepts any non-empty secret so local setups keep working', () => {
      expect(() =>
        validateEnv({ DATABASE_URL, JWT_SECRET: 'dev' }),
      ).not.toThrow();
      expect(() =>
        validateEnv({ DATABASE_URL, JWT_SECRET: exampleSecret() }),
      ).not.toThrow();
    });
  });

  describe('in production', () => {
    const prod = (JWT_SECRET: string) => () =>
      validateEnv({ NODE_ENV: 'production', DATABASE_URL, JWT_SECRET });

    it('accepts a long random secret', () => {
      expect(prod(STRONG)).not.toThrow();
    });

    it('refuses a secret shorter than 32 characters', () => {
      expect(prod(STRONG.slice(0, 31))).toThrow(/JWT_SECRET/);
      expect(prod(STRONG.slice(0, 32))).not.toThrow();
    });

    it('refuses the example secret shipped in .env.example', () => {
      expect(prod(exampleSecret())).toThrow(/JWT_SECRET/);
    });
  });

  it('passes the config through unchanged when it is valid', () => {
    const config = { DATABASE_URL, JWT_SECRET: STRONG, EXTRA: 'kept' };
    expect(validateEnv(config)).toEqual(config);
  });
});
