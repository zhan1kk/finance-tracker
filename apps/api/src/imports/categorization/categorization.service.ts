import { Inject, Injectable } from '@nestjs/common';
import {
  CATEGORIZATION_PROVIDER,
  type CategorizationInput,
  type CategorizationPrediction,
  type CategorizationProvider,
  type SubcategoryLite,
} from '../types/import.types';
import {
  CategorizerFactory,
  type CategorizerOption,
} from './categorizer.factory';

/**
 * Thin seam over the categorization providers so the rest of the app is
 * decoupled from whether the heuristic or an LLM is running, and from how one
 * gets built.
 */
@Injectable()
export class CategorizationService {
  constructor(
    @Inject(CATEGORIZATION_PROVIDER)
    private readonly provider: CategorizationProvider,
    private readonly factory: CategorizerFactory,
  ) {}

  /**
   * The provider an import should run on: the one it asked for, or the server
   * default. Resolved once per import and then carried, so the batch records
   * the provider that actually ran rather than whatever is configured now.
   */
  resolve(id?: string | null): CategorizationProvider {
    return id ? this.factory.create(id) : this.provider;
  }

  /** What this server can offer, for a UI to render as a choice. */
  options(): CategorizerOption[] {
    return this.factory.options();
  }

  categorize(
    inputs: CategorizationInput[],
    subcategories: SubcategoryLite[],
    provider: CategorizationProvider = this.provider,
  ): Promise<CategorizationPrediction[]> {
    if (inputs.length === 0) return Promise.resolve([]);
    return provider.categorize(inputs, subcategories);
  }
}
