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

describe('coercePredictions — models that do not echo the row id', () => {
  const chunk = [
    {
      rowId: '1',
      description: 'REWE',
      amount: -1500,
      date: '2026-08-10',
      type: 'EXPENSE' as const,
    },
    {
      rowId: '2',
      description: 'SPOTIFY',
      amount: -999,
      date: '2026-08-10',
      type: 'EXPENSE' as const,
    },
  ];
  const allowed = new Set(['a', 'd']);

  // Observed from qwen3:4b: it answered with rowId "description" and
  // "SPOTIFY P1A2B3" while picking the right categories. Matching on id alone
  // discarded correct answers and sent the whole chunk to manual review.
  it('falls back to position when no id matches and the count lines up', () => {
    const out = coercePredictions(
      [
        { rowId: 'description', subcategoryId: 'a', confidence: 0.95 },
        { rowId: 'SPOTIFY P1A2B3', subcategoryId: 'd', confidence: 0.9 },
      ],
      chunk,
      allowed,
    );
    expect(out).toEqual([
      { rowId: '1', subcategoryId: 'a', confidence: 0.95 },
      { rowId: '2', subcategoryId: 'd', confidence: 0.9 },
    ]);
  });

  it('prefers explicit ids, even when they arrive out of order', () => {
    const out = coercePredictions(
      [
        { rowId: '2', subcategoryId: 'd', confidence: 0.9 },
        { rowId: '1', subcategoryId: 'a', confidence: 0.8 },
      ],
      chunk,
      allowed,
    );
    expect(out.map((p) => p.subcategoryId)).toEqual(['a', 'd']);
  });

  // The dangerous case: guessing by position here would file real categories
  // against the wrong transactions.
  it('does NOT align by position when the count differs', () => {
    const out = coercePredictions(
      [{ rowId: 'whatever', subcategoryId: 'a', confidence: 0.95 }],
      chunk,
      allowed,
    );
    expect(out.every((p) => p.subcategoryId === null)).toBe(true);
  });

  it('still rejects ids the user does not own, positional or not', () => {
    const out = coercePredictions(
      [
        { rowId: 'x', subcategoryId: 'not-mine', confidence: 0.99 },
        { rowId: 'y', subcategoryId: 'd', confidence: 0.9 },
      ],
      chunk,
      allowed,
    );
    expect(out[0].subcategoryId).toBeNull();
    expect(out[1].subcategoryId).toBe('d');
  });
});
