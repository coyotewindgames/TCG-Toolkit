/** Turns uploaded CSV text into raw rows. Owns the csvtojson dependency. */
import csvToJson from 'csvtojson';
import type { ParsedCsvRow } from './types';

/** Parses CSV text into string-valued rows, tolerating a leading BOM. */
export async function parseCsv(text: string): Promise<ParsedCsvRow[]> {
  const hasByteOrderMark = text.charCodeAt(0) === 0xfeff;
  const csvText = hasByteOrderMark ? text.slice(1) : text;

  const rows = await csvToJson({
    trim: false,
    checkType: false,
    ignoreEmpty: true,
  }).fromString(csvText);

  return rows.map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([key, value]) => [
        key,
        typeof value === 'string' ? value : String(value ?? ''),
      ]),
    ),
  );
}
