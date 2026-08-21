import type { TransactionType } from '@prisma/client';
import { normalizeMerchant } from './normalization';
import { normalizePattern, RulesService } from './rules.service';

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
