import type { TransactionType } from '@prisma/client';

export type SubcategoryLite = {
  id: string;
  name: string;
  category: string;
};

export type CategorizationInput = {
  rowId: string;
  description: string;
  normalizedDescription: string;
  /** Positive minor units (cents). */
  amount: number;
  type: TransactionType;
};

export type CategorizationPrediction = {
  rowId: string;
  subcategoryId: string | null;
  /** 0..1 */
  confidence: number;
  /** Why the model never looked at this row: the call failed, so the row went
   *  to review untouched. Absent when the model ran, even if it abstained —
   *  an abstention is an answer, a failed call is not. */
  error?: string;
};

/**
 * A pluggable transaction categorizer. The heuristic implementation is always
 * available; the Anthropic implementation is selected when an API key is set.
 */
export interface CategorizationProvider {
  readonly name: string;
  /** The model behind this provider, when there is one. Recorded per import so
   *  runs can be compared across models after the fact. */
  readonly modelName?: string;
  categorize(
    inputs: CategorizationInput[],
    subcategories: SubcategoryLite[],
  ): Promise<CategorizationPrediction[]>;
}

export const CATEGORIZATION_PROVIDER = Symbol('CATEGORIZATION_PROVIDER');
