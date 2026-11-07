import { CsvError, parse, type Info } from "csv-parse/sync";

export type CsvRow = {
  /** The line the row ends on. The header is line 1. */
  line: number;
  /** How many cells the row has. A short or long row differs from the header's column count. */
  cellCount: number;
  /** The row's cells under their camelCase column names. A short row lacks its last columns; a long row's extra cells are dropped. */
  record: Record<string, string>;
};

/** `columns` holds the header's names in camelCase. */
export type CsvTable = { columns: string[]; rows: CsvRow[] };

const camelCase = (name: string) => name.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

/** Every record, the header first. With `info: true` csv-parse wraps each one, which its types do not say. */
function records(text: string, file: string): { record: string[]; info: Info }[] {
  try {
    // relax_column_count returns a short or long row instead of failing the whole file.
    return parse(text, { info: true, relax_column_count: true }) as unknown as { record: string[]; info: Info }[];
  } catch (error) {
    if (error instanceof CsvError) throw new Error(`${file} is not valid CSV: ${error.message}`);
    throw error;
  }
}

/** `required` names columns as the file spells them. `file` names the input in errors. */
export function parseCsv(text: string, file: string, required: readonly string[]): CsvTable {
  if (text.startsWith("﻿")) {
    throw new Error(`${file} starts with a byte order mark (BOM); save it as UTF-8 without one`);
  }
  const [header, ...body] = records(text, file);
  if (header === undefined) throw new Error(`${file} is empty`);

  const missing = required.filter((name) => !header.record.includes(name));
  if (missing.length > 0) throw new Error(`${file} is missing columns: ${missing.join(", ")}`);
  if (body.length === 0) throw new Error(`${file} has no rows`);

  const columns = header.record.map(camelCase);
  return {
    columns,
    rows: body.map(({ record, info }) => ({
      line: info.lines,
      cellCount: record.length,
      record: Object.fromEntries(record.slice(0, columns.length).map((cell, i) => [columns[i]!, cell])),
    })),
  };
}
