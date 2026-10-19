-- The unique constraint on the same three columns already has its own index,
-- which serves every query this one could. Only extra writes and disk.
DROP INDEX "ExchangeRate_userId_currency_date_idx";
