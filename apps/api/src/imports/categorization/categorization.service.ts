import { Inject, Injectable } from '@nestjs/common';
import {
  CATEGORIZATION_PROVIDER,
  type CategorizationInput,
  type CategorizationPrediction,
  type CategorizationProvider,
  type SubcategoryLite,
} from '../types/import.types';

/**
 * Thin seam over the active categorization provider so the rest of the app is
 * decoupled from whether the heuristic or the LLM is running.
 */
@Injectable()
export class CategorizationService {
  constructor(
    @Inject(CATEGORIZATION_PROVIDER)
    private readonly provider: CategorizationProvider,
  ) {}

  get providerName(): string {
    return this.provider.name;
  }

  get modelName(): string | null {
    return this.provider.modelName ?? null;
  }

  categorize(
    inputs: CategorizationInput[],
    subcategories: SubcategoryLite[],
  ): Promise<CategorizationPrediction[]> {
    if (inputs.length === 0) return Promise.resolve([]);
    return this.provider.categorize(inputs, subcategories);
  }
}
