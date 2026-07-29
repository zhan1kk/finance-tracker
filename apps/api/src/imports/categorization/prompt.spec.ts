import type { CategorizationInput } from '../types/import.types';
import { buildCategorizationPrompt, coercePredictions } from './prompt';

const input = (rowId: string): CategorizationInput => ({
  rowId,
  description: 'x',
  normalizedDescription: 'x',
  amount: 100,
  type: 'EXPENSE',
});

const allowed = new Set(['a', 'b']);

describe('coercePredictions', () => {
  it('keeps a valid, listed prediction as-is', () => {
    expect(
      coercePredictions(
        [{ rowId: 'r1', subcategoryId: 'a', confidence: 0.8 }],
        [input('r1')],
        allowed,
      ),
    ).toEqual([{ rowId: 'r1', subcategoryId: 'a', confidence: 0.8 }]);
  });

  it('nulls a subcategory id the user does not own', () => {
    expect(
      coercePredictions(
        [{ rowId: 'r1', subcategoryId: 'hallucinated', confidence: 0.9 }],
        [input('r1')],
        allowed,
      )[0],
    ).toEqual({ rowId: 'r1', subcategoryId: null, confidence: 0.9 });
  });

  it('clamps out-of-range and rejects non-numeric confidence', () => {
    const out = coercePredictions(
      [
        { rowId: 'r1', subcategoryId: 'a', confidence: 5 },
        { rowId: 'r2', subcategoryId: 'b', confidence: -1 },
        { rowId: 'r3', subcategoryId: 'a', confidence: 'high' },
      ],
      [input('r1'), input('r2'), input('r3')],
      allowed,
    );
    expect(out.map((o) => o.confidence)).toEqual([1, 0, 0]);
  });

  it('fills a row the model omitted with null/0', () => {
    expect(
      coercePredictions(
        [{ rowId: 'r1', subcategoryId: 'a', confidence: 0.7 }],
        [input('r1'), input('r2')],
        allowed,
      )[1],
    ).toEqual({ rowId: 'r2', subcategoryId: null, confidence: 0 });
  });

  it('falls back entirely when items is not an array', () => {
    expect(coercePredictions(null, [input('r1')], allowed)).toEqual([
      { rowId: 'r1', subcategoryId: null, confidence: 0 },
    ]);
  });
});

describe('buildCategorizationPrompt', () => {
  it('lists each subcategory id and every transaction row', () => {
    const prompt = buildCategorizationPrompt(
      [input('r1')],
      [{ id: 'a', name: 'Groceries', category: 'Expenses' }],
    );
    expect(prompt).toContain('a — Groceries (Expenses)');
    expect(prompt).toContain('rowId r1');
  });
});
