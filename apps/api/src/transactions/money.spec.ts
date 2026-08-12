import { effectOnAccount, signedDelta } from './money';

describe('signedDelta', () => {
  it('income adds, expense subtracts', () => {
    expect(signedDelta('INCOME', 500)).toBe(500);
    expect(signedDelta('EXPENSE', 500)).toBe(-500);
  });
});

describe('effectOnAccount', () => {
  const transfer = {
    type: 'TRANSFER' as const,
    amount: 300,
    accountId: 'src',
    counterAccountId: 'dst',
  };

  it('income/expense affect only their own account', () => {
    expect(effectOnAccount({ type: 'INCOME', amount: 100, accountId: 'a' }, 'a')).toBe(100);
    expect(effectOnAccount({ type: 'EXPENSE', amount: 100, accountId: 'a' }, 'a')).toBe(-100);
    expect(effectOnAccount({ type: 'INCOME', amount: 100, accountId: 'a' }, 'b')).toBe(0);
  });

  it('transfer subtracts from source, adds to counter, ignores others', () => {
    expect(effectOnAccount(transfer, 'src')).toBe(-300);
    expect(effectOnAccount(transfer, 'dst')).toBe(300);
    expect(effectOnAccount(transfer, 'other')).toBe(0);
  });
});
