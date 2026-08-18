import type { ConfigService } from '@nestjs/config';

/**
 * Reads a setting, treating blank as absent.
 *
 * Compose passes optional variables through as `VAR: ${VAR:-}`, which defines
 * them as the empty string rather than leaving them unset. `??` does not fall
 * back on `''`, so a plain `config.get('X') ?? fallback` silently yields `''` —
 * which reached Ollama as an empty model name and made every reminder scan fail
 * with HTTP 400. Anything optional should be read through this.
 */
export function optionalSetting(
  config: ConfigService,
  key: string,
): string | undefined {
  const value = config.get<string>(key)?.trim();
  return value ? value : undefined;
}

/** Same, for a numeric setting: blank or unparsable falls back. */
export function numericSetting(
  config: ConfigService,
  key: string,
  fallback: number,
): number {
  const raw = optionalSetting(config, key);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}
