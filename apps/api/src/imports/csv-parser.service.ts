import { BadRequestException, Injectable } from '@nestjs/common';
import { parse } from 'csv-parse/sync';

export type ParsedCsv = {
  headers: string[];
  records: Record<string, string>[];
};

@Injectable()
export class CsvParserService {
  /**
   * Parses raw CSV text into header names and per-row objects. When the file
   * has no header row, synthetic names `col1..colN` are used. Duplicate header
   * names are de-collided with a numeric suffix so the mapping stays unambiguous.
   */
  parse(text: string, hasHeader = true): ParsedCsv {
    let rows: string[][];
    try {
      rows = parse(text, {
        skip_empty_lines: true,
        trim: true,
        bom: true,
        relax_column_count: true,
        relax_quotes: true,
      });
    } catch (err) {
      throw new BadRequestException(
        `Could not parse CSV: ${err instanceof Error ? err.message : 'invalid format'}`,
      );
    }

    if (rows.length === 0) {
      throw new BadRequestException('The CSV file is empty');
    }

    const headers = hasHeader
      ? dedupeHeaders(rows[0].map((h) => h.trim()))
      : rows[0].map((_, i) => `col${i + 1}`);
    const dataRows = hasHeader ? rows.slice(1) : rows;

    const records = dataRows.map((row) =>
      Object.fromEntries(headers.map((h, i) => [h, (row[i] ?? '').trim()])),
    );

    return { headers, records };
  }
}

function dedupeHeaders(headers: string[]): string[] {
  const seen = new Map<string, number>();
  return headers.map((raw, i) => {
    const name = raw === '' ? `col${i + 1}` : raw;
    const count = seen.get(name) ?? 0;
    seen.set(name, count + 1);
    return count === 0 ? name : `${name}_${count + 1}`;
  });
}
