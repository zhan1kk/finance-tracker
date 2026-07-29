import { inflateRawSync } from 'node:zlib';

/**
 * Minimal read-only .xlsx reader built on the standard library.
 *
 * An .xlsx is a ZIP of XML parts; we only need the shared-string table and each
 * worksheet's cell values. Formulas are irrelevant here because Excel caches
 * every formula's computed result in the same `<v>` element we read.
 *
 * Hand-rolled rather than pulling in a spreadsheet dependency: this parses
 * user-uploaded files on a public server, so the smallest possible surface wins.
 * Everything is bounded (see the limits below) so a malicious archive cannot
 * exhaust memory.
 */

/** Largest archive we will look at, and largest single part we will inflate. */
const MAX_ARCHIVE_BYTES = 20 * 1024 * 1024;
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;

/** Sparse cell grid: row number -> column index -> raw cell text. */
export type SheetCells = Map<number, Map<number, string>>;
export type Sheet = { name: string; cells: SheetCells };

export class XlsxError extends Error {}

/** Parses a workbook into its sheets, in workbook order. */
export function readWorkbook(buffer: Buffer): Sheet[] {
  if (buffer.length > MAX_ARCHIVE_BYTES) {
    throw new XlsxError('Spreadsheet is too large (limit 20 MB)');
  }
  const entries = readZipDirectory(buffer);
  if (!entries.has('xl/workbook.xml')) {
    throw new XlsxError('Not a valid .xlsx workbook');
  }

  const shared = parseSharedStrings(
    readEntryText(buffer, entries, 'xl/sharedStrings.xml'),
  );
  const targets = resolveSheetTargets(
    readEntryText(buffer, entries, 'xl/workbook.xml'),
    readEntryText(buffer, entries, 'xl/_rels/workbook.xml.rels'),
  );

  const sheets: Sheet[] = [];
  for (const { name, target } of targets) {
    if (!entries.has(target)) continue;
    const xml = readEntryText(buffer, entries, target);
    sheets.push({ name, cells: parseSheetCells(xml, shared) });
  }
  return sheets;
}

// ---- ZIP ----

type ZipEntry = { offset: number; compressedSize: number; method: number };

/**
 * Reads the ZIP central directory. Sizes come from the directory (not the local
 * header), which is what makes streamed archives with data descriptors safe.
 */
function readZipDirectory(buffer: Buffer): Map<string, ZipEntry> {
  // The end-of-central-directory record lives in the last 64KB (+22 byte record).
  const searchFrom = Math.max(0, buffer.length - 66 * 1024);
  let eocd = -1;
  for (let i = buffer.length - 22; i >= searchFrom; i--) {
    if (buffer.readUInt32LE(i) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new XlsxError('Not a valid .xlsx file (no ZIP directory)');

  const count = buffer.readUInt16LE(eocd + 10);
  let pointer = buffer.readUInt32LE(eocd + 16);
  const entries = new Map<string, ZipEntry>();

  for (let i = 0; i < count; i++) {
    if (pointer + 46 > buffer.length) break;
    if (buffer.readUInt32LE(pointer) !== CENTRAL_SIGNATURE) break;
    const method = buffer.readUInt16LE(pointer + 10);
    const compressedSize = buffer.readUInt32LE(pointer + 20);
    const nameLength = buffer.readUInt16LE(pointer + 28);
    const extraLength = buffer.readUInt16LE(pointer + 30);
    const commentLength = buffer.readUInt16LE(pointer + 32);
    const offset = buffer.readUInt32LE(pointer + 42);
    const name = buffer
      .subarray(pointer + 46, pointer + 46 + nameLength)
      .toString('utf8');
    entries.set(name, { offset, compressedSize, method });
    pointer += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** Inflates one entry to text; returns '' when the part is absent. */
function readEntryText(
  buffer: Buffer,
  entries: Map<string, ZipEntry>,
  name: string,
): string {
  const entry = entries.get(name);
  if (!entry) return '';

  // The local header repeats the name/extra lengths; data follows it.
  const header = entry.offset;
  if (header + 30 > buffer.length) throw new XlsxError('Corrupt .xlsx entry');
  const nameLength = buffer.readUInt16LE(header + 26);
  const extraLength = buffer.readUInt16LE(header + 28);
  const start = header + 30 + nameLength + extraLength;
  const data = buffer.subarray(start, start + entry.compressedSize);

  if (entry.method === 0) {
    return data.toString('utf8');
  }
  if (entry.method !== 8) {
    throw new XlsxError(`Unsupported compression in ${name}`);
  }
  const inflated = inflateRawSync(data, { maxOutputLength: MAX_ENTRY_BYTES });
  return inflated.toString('utf8');
}

// ---- XML ----

const CELL_PATTERN = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
const VALUE_PATTERN = /<v[^>]*>([\s\S]*?)<\/v>/;
const TEXT_PATTERN = /<t[^>]*>([\s\S]*?)<\/t>/g;

function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, code: string) =>
      String.fromCodePoint(Number(code)),
    )
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    )
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function collectText(xml: string): string {
  let out = '';
  for (const match of xml.matchAll(TEXT_PATTERN)) {
    out += match[1];
  }
  return decodeEntities(out);
}

function parseSharedStrings(xml: string): string[] {
  if (!xml) return [];
  const strings: string[] = [];
  for (const match of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
    // Drop phonetic hints so Japanese/Chinese labels don't get doubled.
    strings.push(collectText(match[1].replace(/<rPh[\s\S]*?<\/rPh>/g, '')));
  }
  return strings;
}

/** Sheet name -> part path, following the workbook's relationship ids. */
function resolveSheetTargets(
  workbookXml: string,
  relsXml: string,
): { name: string; target: string }[] {
  const targetById = new Map<string, string>();
  for (const match of relsXml.matchAll(/<Relationship\b([^>]*)\/>/g)) {
    const id = /Id="([^"]+)"/.exec(match[1])?.[1];
    const target = /Target="([^"]+)"/.exec(match[1])?.[1];
    if (id && target) {
      targetById.set(id, target.startsWith('/') ? target.slice(1) : target);
    }
  }

  const sheets: { name: string; target: string }[] = [];
  for (const match of workbookXml.matchAll(/<sheet\b([^>]*)\/?>/g)) {
    const name = /name="([^"]*)"/.exec(match[1])?.[1];
    const id = /r:id="([^"]+)"/.exec(match[1])?.[1];
    if (!name || !id) continue;
    let target = targetById.get(id);
    if (!target) continue;
    if (!target.startsWith('xl/')) target = `xl/${target}`;
    sheets.push({ name: decodeEntities(name), target });
  }
  return sheets;
}

/** "BC12" -> { row: 12, col: 54 } (column is 0-based). */
export function parseCellRef(ref: string): { row: number; col: number } | null {
  const match = /^([A-Z]+)(\d+)$/.exec(ref);
  if (!match) return null;
  let col = 0;
  for (const char of match[1]) {
    col = col * 26 + (char.charCodeAt(0) - 64);
  }
  return { row: Number(match[2]), col: col - 1 };
}

function parseSheetCells(xml: string, shared: string[]): SheetCells {
  const cells: SheetCells = new Map();

  for (const match of xml.matchAll(CELL_PATTERN)) {
    const attributes = match[1];
    const body = match[2] ?? '';
    const ref = /r="([A-Z]+\d+)"/.exec(attributes)?.[1];
    if (!ref) continue;
    const position = parseCellRef(ref);
    if (!position) continue;

    const type = /t="([^"]+)"/.exec(attributes)?.[1];
    let value: string;
    if (type === 's') {
      const index = Number(VALUE_PATTERN.exec(body)?.[1]);
      value = Number.isInteger(index) ? (shared[index] ?? '') : '';
    } else if (type === 'inlineStr') {
      value = collectText(body);
    } else {
      // Numbers, dates, booleans and cached formula results all live in <v>.
      value = decodeEntities(VALUE_PATTERN.exec(body)?.[1] ?? '');
    }

    value = value.trim();
    if (value === '') continue;

    let row = cells.get(position.row);
    if (!row) {
      row = new Map();
      cells.set(position.row, row);
    }
    row.set(position.col, value);
  }

  return cells;
}
