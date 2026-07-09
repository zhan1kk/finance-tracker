import { checkOutlier } from './outlier';

describe('checkOutlier', () => {
  const groceries = [1200, 1500, 1100, 1400, 1300, 1250, 1600, 1350, 1450];

  it('stays quiet with too little history', () => {
    expect(checkOutlier([1000, 1100, 1200], 99_999)).toBeNull();
  });

  it('stays quiet for unremarkable amounts', () => {
    expect(checkOutlier(groceries, 1500)).toBeNull();
    expect(checkOutlier(groceries, 1800)).toBeNull();
  });

  it('flags a clearly high amount with the typical median', () => {
    expect(checkOutlier(groceries, 15_000)).toEqual({
      direction: 'high',
      medianCents: 1350,
    });
  });

  it('flags a clearly low amount', () => {
    expect(checkOutlier(groceries, 10)).toMatchObject({ direction: 'low' });
  });

  it('handles a perfectly uniform history without dividing by zero', () => {
    const netflix = Array(10).fill(1299) as number[];
    expect(checkOutlier(netflix, 1299)).toBeNull();
    expect(checkOutlier(netflix, 2598)).toBeNull(); // exactly 2× is the edge
    expect(checkOutlier(netflix, 2599)).toMatchObject({ direction: 'high' });
  });
});
