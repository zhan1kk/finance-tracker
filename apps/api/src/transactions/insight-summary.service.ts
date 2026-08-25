import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { optionalSetting } from '../common/env';

/** The exact, already-computed facts to phrase — never re-derived by the model. */
export type InsightSummaryInput = {
  month: string;
  /** One-line overall-spend fact, or null if there's nothing notable. */
  overall: string | null;
  /** Per-category mover facts, e.g. "Dining Out is up 32% (+€85)". */
  movers: string[];
};

// A couple of sentences from a 4B model on CPU takes tens of seconds; 30s was
// tight even before accounting for a cold load, and this is a button the user
// is actively waiting on, so it fails visibly rather than silently.
const TIMEOUT_MS = 90_000;

/**
 * Turns the dashboard's exact spending facts into one or two friendly
 * sentences with a local Ollama model. On-demand only (a button), so it never
 * slows the overview. The model only *rephrases* the numbers it's given — it is
 * told not to invent or change any figure — so the summary can't hallucinate.
 */
@Injectable()
export class InsightSummaryService {
  private readonly logger = new Logger(InsightSummaryService.name);

  constructor(private readonly config: ConfigService) {}

  async summarize(
    input: InsightSummaryInput,
  ): Promise<{ summary: string | null }> {
    const facts = [input.overall, ...input.movers].filter(
      (f): f is string => !!f && f.trim() !== '',
    );
    if (facts.length === 0) return { summary: null };

    const baseUrl =
      optionalSetting(this.config, 'OLLAMA_BASE_URL') ??
      'http://localhost:11434';
    const model =
      optionalSetting(this.config, 'OLLAMA_EXTRACTION_MODEL') ??
      optionalSetting(this.config, 'OLLAMA_MODEL') ??
      'llama3.1';

    const system =
      'You turn a list of exact personal-spending facts into ONE or TWO short, ' +
      'friendly sentences for a dashboard. Use ONLY the numbers given — never ' +
      'invent, drop, or change a figure. No preamble, no lists, no markdown. Be ' +
      'concise and neutral.';
    const user = `Month: ${input.month}\nFacts:\n${facts
      .map((f) => `- ${f}`)
      .join('\n')}\n\nWrite the summary.`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          model,
          stream: false,
          // Hybrid models (qwen3) reason at length before answering unless
          // told not to; on CPU that reasoning is most of the wall time and is
          // what pushed these calls past their timeout. See ollama.provider.ts.
          think: false,
          keep_alive: '10m',
          options: { temperature: 0.3 },
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
      });
      if (!res.ok) {
        throw new BadRequestException(
          `Ollama summary failed (HTTP ${res.status}). Is Ollama running and "${model}" pulled?`,
        );
      }
      const data = (await res.json()) as { message?: { content?: unknown } };
      const content = data.message?.content;
      return {
        summary: typeof content === 'string' ? content.trim() : null,
      };
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      const message =
        err instanceof Error && err.name === 'AbortError'
          ? 'Ollama took too long to write the summary (timed out).'
          : `Ollama summary failed: ${
              err instanceof Error ? err.message : String(err)
            }. Is Ollama running at ${baseUrl}?`;
      this.logger.warn(message);
      throw new BadRequestException(message);
    } finally {
      clearTimeout(timer);
    }
  }
}
