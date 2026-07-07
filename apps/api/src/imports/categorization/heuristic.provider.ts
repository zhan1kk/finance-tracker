import { Injectable } from '@nestjs/common';
import type {
  CategorizationInput,
  CategorizationPrediction,
  CategorizationProvider,
  SubcategoryLite,
} from '../types/import.types';

const NAME_MATCH_CONFIDENCE = 0.9;

/**
 * The zero-config fallback categorizer (used when no LLM API key is set) and
 * the one the tests exercise deterministically. It makes exactly one safe,
 * personalized guess: if one of the user's own subcategory names appears as a
 * whole word in the normalized description (e.g. "monthly rent" → "Rent"), it
 * predicts that subcategory. It intentionally holds NO hardcoded brand/merchant
 * dictionary — automatic categorization of real merchants is the LLM's job, and
 * repeat merchants become free through learned rules. Anything it can't name-
 * match returns null and lands in the review queue for the user to decide.
 */
@Injectable()
export class HeuristicCategorizationProvider implements CategorizationProvider {
  readonly name = 'heuristic';

  categorize(
    inputs: CategorizationInput[],
    subcategories: SubcategoryLite[],
  ): Promise<CategorizationPrediction[]> {
    const predictions = inputs.map((input) => {
      const candidates = subcategories.filter((s) =>
        input.type === 'INCOME'
          ? s.category === 'Income'
          : s.category !== 'Income',
      );
      const text = ` ${input.normalizedDescription} `;
      const named = candidates.find((s) =>
        text.includes(` ${s.name.toLowerCase()} `),
      );
      return named
        ? {
            rowId: input.rowId,
            subcategoryId: named.id,
            confidence: NAME_MATCH_CONFIDENCE,
          }
        : { rowId: input.rowId, subcategoryId: null, confidence: 0 };
    });

    return Promise.resolve(predictions);
  }
}
