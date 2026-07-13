/**
 * Fail-fast environment validation, run by ConfigModule before anything boots.
 * Strictness scales with NODE_ENV: production refuses weak/example secrets;
 * dev and test only require presence so local setups keep working.
 */
export function validateEnv(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const production = config.NODE_ENV === 'production';
  const errors: string[] = [];

  const databaseUrl = config.DATABASE_URL;
  if (
    typeof databaseUrl !== 'string' ||
    !/^postgres(ql)?:\/\//i.test(databaseUrl)
  ) {
    errors.push('DATABASE_URL must be a postgresql:// connection string');
  }

  const secret = config.JWT_SECRET;
  if (typeof secret !== 'string' || secret.length === 0) {
    errors.push('JWT_SECRET must be set (generate one: openssl rand -hex 32)');
  } else if (
    production &&
    (secret.length < 32 || secret.includes('replace-me'))
  ) {
    errors.push(
      'JWT_SECRET is too weak for production — use ≥32 random characters (openssl rand -hex 32)',
    );
  }

  if (errors.length > 0) {
    throw new Error(`Environment validation failed:\n- ${errors.join('\n- ')}`);
  }
  return config;
}
