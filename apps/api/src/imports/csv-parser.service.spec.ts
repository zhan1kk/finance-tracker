import { BadRequestException } from '@nestjs/common';
import { CsvParserService } from './csv-parser.service';

describe('CsvParserService', () => {
  const service = new CsvParserService();

  it('parses a header row and keys records by header', () => {
    const { headers, records } = service.parse(
      'Date,Amount,Description\n2026-07-01,-12.50,Albert Heijn',
    );
    expect(headers).toEqual(['Date', 'Amount', 'Description']);
    expect(records).toEqual([
      { Date: '2026-07-01', Amount: '-12.50', Description: 'Albert Heijn' },
    ]);
  });

  it('synthesizes column names when there is no header', () => {
    const { headers, records } = service.parse('2026-07-01,-12.50', false);
    expect(headers).toEqual(['col1', 'col2']);
    expect(records[0]).toEqual({ col1: '2026-07-01', col2: '-12.50' });
  });

  it('honors quoted fields containing commas', () => {
    const { records } = service.parse(
      'Date,Description\n2026-07-01,"Shop, The Big One"',
    );
    expect(records[0].Description).toBe('Shop, The Big One');
  });

  it('de-collides duplicate header names', () => {
    const { headers } = service.parse('Amount,Amount\n1,2');
    expect(headers).toEqual(['Amount', 'Amount_2']);
  });

  it('throws on an empty file', () => {
    expect(() => service.parse('')).toThrow(BadRequestException);
  });
});
