import { OLLAMA_KEEP_ALIVE } from '../common/ollama';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { optionalSetting } from '../common/env';
import {
  buildReminderPrompt,
  coerceExtractedReminders,
  type ExtractedReminder,
  type ReminderCandidate,
  REMINDER_EXTRACTION_SCHEMA,
  REMINDER_SYSTEM_PROMPT,
} from './reminder-prompt';

const REQUEST_TIMEOUT_MS = 120_000;
// Ollama's default context is small; the candidate list plus prompt needs room.
const NUM_CTX = 8192;

/**
 * Reads upcoming-payment reminders out of transaction descriptions with a local
 * Ollama model. Always uses OLLAMA_BASE_URL / OLLAMA_MODEL, independent of the
 * CATEGORIZER setting — extraction is a local, private, zero-cost step.
 */
@Injectable()
export class ReminderExtractionService {
  private readonly logger = new Logger(ReminderExtractionService.name);

  constructor(private readonly config: ConfigService) {}

  async extract(candidates: ReminderCandidate[]): Promise<ExtractedReminder[]> {
    if (candidates.length === 0) return [];
    const baseUrl =
      optionalSetting(this.config, 'OLLAMA_BASE_URL') ??
      'http://localhost:11434';
    // Extraction is structured and forgiving, so it can run on a leaner (faster,
    // lighter) model than the categorizer — set OLLAMA_EXTRACTION_MODEL to point
    // the reminder/PDF jobs at e.g. llama3.2:3b. Falls back to OLLAMA_MODEL.
    const model =
      optionalSetting(this.config, 'OLLAMA_EXTRACTION_MODEL') ??
      optionalSetting(this.config, 'OLLAMA_MODEL') ??
      'llama3.1';

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
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
          keep_alive: OLLAMA_KEEP_ALIVE,
          format: REMINDER_EXTRACTION_SCHEMA,
          options: { temperature: 0, num_ctx: NUM_CTX },
          messages: [
            { role: 'system', content: REMINDER_SYSTEM_PROMPT },
            { role: 'user', content: buildReminderPrompt(candidates) },
          ],
        }),
      });

      if (!res.ok) {
        throw new BadRequestException(
          `Ollama reminder scan failed (HTTP ${res.status}). Is Ollama running and the model "${model}" pulled?`,
        );
      }

      const data = (await res.json()) as { message?: { content?: unknown } };
      const content = data.message?.content;
      if (typeof content !== 'string') return [];
      const parsed = JSON.parse(content) as { reminders?: unknown };
      return coerceExtractedReminders(parsed.reminders);
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      const message =
        err instanceof Error && err.name === 'AbortError'
          ? 'Ollama took too long to scan for reminders (timed out).'
          : `Ollama reminder scan failed: ${
              err instanceof Error ? err.message : String(err)
            }. Is Ollama running at ${baseUrl}?`;
      this.logger.error(message);
      throw new BadRequestException(message);
    } finally {
      clearTimeout(timer);
    }
  }
}
