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

const BOM = 0xfeff;

const camelCase = (name: string) => name.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

/** Every record, the header first. With `info: true` csv-parse wraps each one, which its types do not say. */
function records(text: string, file: string): { record: string[]; info: Info }[] {
  try {
    return parse(text, {
      info: true,
      // A short or long row comes back instead of failing the whole file.
      relax_column_count: true,
      // csv-parse otherwise splits the whole file at the first line ending it meets, so rows added
      // with LF to a CRLF file would merge into one.
      record_delimiter: ["\r\n", "\n", "\r"],
    }) as unknown as { record: string[]; info: Info }[];
  } catch (error) {
    if (error instanceof CsvError) throw new Error(`${file} is not valid CSV: ${error.message}`);
    throw error;
  }
}

/** The header's names that repeat an earlier one once in camelCase, since one cell would hide the other. */
function repeatedNames(header: readonly string[]): string[] {
  const seen = new Set<string>();
  return header.filter((name) => {
    const key = camelCase(name);
    if (seen.has(key)) return true;
    seen.add(key);
    return false;
  });
}

/** `required` names columns as the file spells them. `file` names the input in errors. */
export function parseCsv(text: string, file: string, required: readonly string[]): CsvTable {
  if (text.charCodeAt(0) === BOM) {
    throw new Error(`${file} starts with a byte order mark (BOM); save it as UTF-8 without one`);
  }
  const [header, ...body] = records(text, file);
  if (header === undefined) throw new Error(`${file} is empty`);

  const missing = required.filter((name) => !header.record.includes(name));
  if (missing.length > 0) {
    // The header as read shows a semicolon or spaces that the column names alone would hide.
    throw new Error(`${file} is missing columns: ${missing.join(", ")}; its header is "${header.record.join(",")}"`);
  }
  const repeated = repeatedNames(header.record);
  if (repeated.length > 0) throw new Error(`${file} repeats columns: ${repeated.join(", ")}`);
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
