import type { CategorizationInput } from '../types/import.types';
import {
  aliasSubcategories,
  buildCategorizationPrompt,
  coercePredictions,
} from './prompt';

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
      normalizedDescription: 'rewe',
      amount: -1500,
      date: '2026-08-10',
      type: 'EXPENSE' as const,
    },
    {
      rowId: '2',
      description: 'SPOTIFY',
      normalizedDescription: 'spotify',
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

describe('aliasSubcategories', () => {
  const subs = [
    {
      id: '6d5d5111-c8db-43ba-a1ce-142c961050c7',
      name: "Kira's food",
      category: 'Expenses',
    },
    {
      id: 'b2c3d4e5-0000-0000-0000-000000000000',
      name: 'Dining Out',
      category: 'Expenses',
    },
  ];

  it('replaces UUIDs with short numbers the model can copy', () => {
    const { aliased, realIdFor } = aliasSubcategories(subs);
    expect(aliased.map((s) => s.id)).toEqual(['c1', 'c2']);
    // Names and categories are untouched; only the id is swapped.
    expect(aliased[0].name).toBe("Kira's food");
    expect(realIdFor.get('c2')).toBe(subs[1].id);
  });

  // The real failure this fixes: asked to copy a 36-character UUID from a list
  // of sixty, qwen2.5:7b answered every row with the same one, so a whole
  // import landed in one arbitrary category at high confidence.
  it('maps an aliased answer back to the real id', () => {
    const { aliased, realIdFor } = aliasSubcategories(subs);
    const chunk = [
      {
        rowId: '1',
        description: 'Cafe Zart',
        normalizedDescription: 'cafe zart',
        amount: -2650,
        date: '2026-07-31',
        type: 'EXPENSE' as const,
      },
    ];
    const out = coercePredictions(
      [{ rowId: '1', subcategoryId: 'c2', confidence: 0.9 }],
      chunk,
      new Set(subs.map((s) => s.id)),
      realIdFor,
    );
    expect(out[0].subcategoryId).toBe(subs[1].id);
    expect(aliased).toHaveLength(2);
  });

  // Row ids in the same prompt are "1".."N". If category aliases shared that
  // namespace, a model echoing the row number would resolve to a real but
  // arbitrary category and pass validation.
  it('does not collide with the row-id namespace', () => {
    const { realIdFor } = aliasSubcategories(subs);
    const chunk = [
      {
        rowId: '1',
        description: 'x',
        normalizedDescription: 'x',
        amount: -1,
        date: '2026-07-31',
        type: 'EXPENSE' as const,
      },
    ];
    const out = coercePredictions(
      [{ rowId: '1', subcategoryId: '1', confidence: 0.9 }],
      chunk,
      new Set(subs.map((s) => s.id)),
      realIdFor,
    );
    expect(out[0].subcategoryId).toBeNull();
  });

  it('rejects an alias the model invented', () => {
    const { realIdFor } = aliasSubcategories(subs);
    const chunk = [
      {
        rowId: '1',
        description: 'x',
        normalizedDescription: 'x',
        amount: -1,
        date: '2026-07-31',
        type: 'EXPENSE' as const,
      },
    ];
    const out = coercePredictions(
      [{ rowId: '1', subcategoryId: 'c99', confidence: 0.9 }],
      chunk,
      new Set(subs.map((s) => s.id)),
      realIdFor,
    );
    expect(out[0].subcategoryId).toBeNull();
  });
});
