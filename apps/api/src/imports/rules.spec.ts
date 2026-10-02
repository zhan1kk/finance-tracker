import type { TransactionType } from '@prisma/client';
import { normalizeMerchant } from './normalization';
import {
  normalizePattern,
  patternMatches,
  RulesService,
} from './rules.service';

/** match() is pure, so it needs no database. */
const rules = new RulesService(null as never);

const rule = (
  id: string,
  pattern: string,
  type: TransactionType,
  target: {
    subcategoryId?: string;
    counterAccountId?: string;
    excludeFromStats?: boolean;
  },
) => ({
  id,
  pattern,
  type,
  subcategoryId: target.subcategoryId ?? null,
  counterAccountId: target.counterAccountId ?? null,
  excludeFromStats: target.excludeFromStats ?? false,
});

describe('RulesService.match', () => {
  // The real case: two people's names, where one is a substring of the joint one.
  const set = [
    rule('r1', 'maria santos', 'TRANSFER', { counterAccountId: 'k-rev' }),
    rule('r2', 'maria santos john smith', 'TRANSFER', {
      counterAccountId: 'joint',
    }),
    rule('r3', 'john smith', 'INCOME', {
      subcategoryId: 'blocked-account',
    }),
  ];

  it('prefers the longest pattern, so the joint account beats either name', () => {
    expect(rules.match(set, 'from maria santos john smith', 'INCOME')).toEqual({
      counterAccountId: 'joint',
      ruleId: 'r2',
    });
  });

  it('matches each name on its own', () => {
    expect(rules.match(set, 'from maria santos', 'INCOME')).toEqual({
      counterAccountId: 'k-rev',
      ruleId: 'r1',
    });
    expect(rules.match(set, 'from john smith', 'INCOME')).toEqual({
      subcategoryId: 'blocked-account',
      ruleId: 'r3',
    });
  });

  it('returns null when nothing matches', () => {
    expect(rules.match(set, 'confiserie reichert', 'EXPENSE')).toBeNull();
  });

  // The Amazon case: one merchant, two meanings by direction. Both rules share
  // the pattern; the row's sign decides which applies.
  it('lets the same merchant mean different things by direction', () => {
    const amazon = [
      rule('buy', 'amazon', 'EXPENSE', { subcategoryId: 'ikea-amazon' }),
      rule('refund', 'amazon', 'INCOME', { subcategoryId: 'refunds' }),
    ];
    expect(rules.match(amazon, 'amazon marketplace', 'EXPENSE')).toEqual({
      subcategoryId: 'ikea-amazon',
      ruleId: 'buy',
    });
    expect(rules.match(amazon, 'amazon marketplace', 'INCOME')).toEqual({
      subcategoryId: 'refunds',
      ruleId: 'refund',
    });
  });

  it('does not apply a rule against the row direction', () => {
    const expenseOnly = [
      rule('buy', 'amazon', 'EXPENSE', { subcategoryId: 'ikea-amazon' }),
    ];
    expect(rules.match(expenseOnly, 'amazon marketplace', 'INCOME')).toBeNull();
  });

  it('applies transfer rules to either direction', () => {
    const transfer = [
      rule('t', 'maria santos', 'TRANSFER', { counterAccountId: 'k-rev' }),
    ];
    expect(rules.match(transfer, 'to maria santos', 'EXPENSE')).toEqual({
      counterAccountId: 'k-rev',
      ruleId: 't',
    });
    expect(rules.match(transfer, 'from maria santos', 'INCOME')).toEqual({
      counterAccountId: 'k-rev',
      ruleId: 't',
    });
  });

  // Deleting a subcategory used to empty its rules instead of removing them
  // (the FK is ON DELETE SET NULL). Such a rule still matched, and the import
  // marked the row READY with a null subcategory — committing it with no
  // category and never showing it for review. It must not match at all.
  it('ignores a rule left with no target', () => {
    const orphan = [rule('u', 'uber', 'EXPENSE', {})];
    expect(
      rules.match(orphan, 'uber trip help uber com', 'EXPENSE'),
    ).toBeNull();
  });

  it('lets a shorter targeted rule win over a longer orphaned one', () => {
    const set = [
      rule('orphan', 'uber eats delivery', 'EXPENSE', {}),
      rule('ok', 'uber', 'EXPENSE', { subcategoryId: 'transport' }),
    ];
    expect(rules.match(set, 'uber eats delivery fee', 'EXPENSE')).toEqual({
      subcategoryId: 'transport',
      ruleId: 'ok',
    });
  });

  it('reports whichever target the winning rule carries', () => {
    const mixed = [
      rule('a', 'rewe', 'EXPENSE', { subcategoryId: 'groceries' }),
      rule('b', 'rewe to go', 'TRANSFER', { counterAccountId: 'cash' }),
    ];
    expect(rules.match(mixed, 'rewe city', 'EXPENSE')).toMatchObject({
      subcategoryId: 'groceries',
    });
    expect(rules.match(mixed, 'rewe to go station', 'EXPENSE')).toMatchObject({
      counterAccountId: 'cash',
    });
  });

  // Regression: a pattern typed with the same noise words that appear on the
  // statement ("Transfer from …") must still match. Patterns and descriptions
  // have to be reduced by the same normalizer for the substring test to work.
  it('matches a rule typed the way the statement reads it', () => {
    const typed = [
      rule('r1', normalizePattern('Transfer from MARIA SANTOS'), 'TRANSFER', {
        counterAccountId: 'k-rev',
      }),
      rule(
        'r2',
        normalizePattern('Transfer from MARIA SANTOS & JOHN SMITH'),
        'TRANSFER',
        { counterAccountId: 'joint' },
      ),
    ];
    const joint = normalizeMerchant('Transfer from MARIA SANTOS & JOHN SMITH');
    const hers = normalizeMerchant('Transfer from MARIA SANTOS');

    expect(rules.match(typed, joint, 'INCOME')).toMatchObject({
      counterAccountId: 'joint',
    });
    expect(rules.match(typed, hers, 'INCOME')).toMatchObject({
      counterAccountId: 'k-rev',
    });
  });
});

describe('patternMatches', () => {
  // The reason wholeWord exists: a short keyword is a substring of longer
  // words. "cos" (the clothing shop) sits inside "costa" and "cosmetics".
  it('substring matching catches a keyword inside a longer word', () => {
    expect(patternMatches('costa coffee', 'cos')).toBe(true);
    expect(patternMatches('cosmetics shop', 'cos')).toBe(true);
  });

  it('whole-word matching does not', () => {
    expect(patternMatches('costa coffee', 'cos', true)).toBe(false);
    expect(patternMatches('cosmetics shop', 'cos', true)).toBe(false);
    expect(patternMatches('cos berlin', 'cos', true)).toBe(true);
  });

  it('handles multi-word patterns on both settings', () => {
    expect(patternMatches('albert heijn amsterdam', 'albert heijn', true)).toBe(
      true,
    );
    expect(patternMatches('albert heijn amsterdam', 'albert heijn')).toBe(true);
  });

  // Why the default stays substring: bank statements truncate merchant names,
  // so a rule learned from a correction can end mid-word. Anchoring those to
  // word boundaries would stop them matching what they were learned from.
  it('keeps matching a truncated learned pattern only on substring', () => {
    expect(
      patternMatches('agentur fur warenwirtschaft', 'agentur fur wa'),
    ).toBe(true);
    expect(
      patternMatches('agentur fur warenwirtschaft', 'agentur fur wa', true),
    ).toBe(false);
  });
});

/**
 * learnFromCorrection creates a rule it does not have and never rewrites one it
 * does. Asserted here rather than end-to-end on purpose: the commit path also
 * carries an `overrulesSameRule` guard that already refuses to learn when the
 * matched rule's pattern equals the row's description, so an API-level test
 * passes whether this holds or not — which makes it no test at all.
 *
 * What this pins is the invariant itself, so the guarantee does not depend on
 * that one pattern comparison continuing to be exactly right.
 */
describe('RulesService.learnFromCorrection', () => {
  const fakeTx = (existing: { id: string } | null) => {
    const create = jest.fn().mockResolvedValue({ id: 'created' });
    const findUnique = jest.fn().mockResolvedValue(existing);
    return {
      tx: { categorizationRule: { create, findUnique } },
      create,
      findUnique,
    };
  };

  it('creates a rule when none exists for that pattern and direction', async () => {
    const { tx, create } = fakeTx(null);
    const service = new RulesService(null as never);

    const result = await service.learnFromCorrection(
      tx as never,
      'user-1',
      'Amazon',
      { subcategoryId: 'sub-shopping' },
      'EXPENSE',
    );

    expect(result).toEqual({ id: 'created' });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0]).toMatchObject({
      data: {
        pattern: 'amazon',
        type: 'EXPENSE',
        subcategoryId: 'sub-shopping',
      },
    });
  });

  it('leaves an existing rule untouched and reports nothing learned', async () => {
    const { tx, create } = fakeTx({ id: 'rule-already-there' });
    const service = new RulesService(null as never);

    const result = await service.learnFromCorrection(
      tx as never,
      'user-1',
      'Amazon',
      { subcategoryId: 'sub-entertainment' },
      'EXPENSE',
    );

    // Null, not the existing rule: the import review offers to "forget" what it
    // reports here, and forgetting a rule that predates the import deletes it.
    expect(result).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  it('learns nothing from a description that normalizes to nothing', async () => {
    const { tx, findUnique, create } = fakeTx(null);
    const service = new RulesService(null as never);

    expect(
      await service.learnFromCorrection(
        tx as never,
        'user-1',
        '   ',
        { subcategoryId: 'sub-shopping' },
        'EXPENSE',
      ),
    ).toBeNull();
    expect(findUnique).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
});
