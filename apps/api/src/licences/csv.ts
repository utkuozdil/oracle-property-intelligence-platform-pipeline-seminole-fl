/**
 * A CSV reader for the DBPR extract.
 *
 * A real parser is mandatory rather than fastidious: licensee names are written
 * `LAST, FIRST M`, so **embedded commas occur inside quoted values on most rows**. Splitting
 * on commas shifts every field after the name and produces plausible-looking garbage — the
 * worst kind of failure for a file with no header row to check against.
 *
 * Exposed as a generator over rows rather than a function returning an array. The extract is
 * 48.8 MB and 271,941 rows; materialising all of them as 6M strings at once costs hundreds
 * of megabytes for a caller that keeps the 5,211 Seminole rows and a licence-number index.
 * Yielding lets the caller retain only what it wants.
 */

/**
 * The extract is latin-1, not UTF-8.
 *
 * Decoding it as UTF-8 replaces accented characters in licensee names with U+FFFD, which
 * then fails to match the same name from any other source. `latin1` never throws and never
 * substitutes, which is the right behaviour for a fixed legacy encoding.
 */
export function decodeLatin1(bytes: Uint8Array): string {
  return new TextDecoder('latin1').decode(bytes);
}

/** A row that did not have the field count the caller demanded. */
export interface RaggedRow {
  /** 1-based line number, for pointing a human at the offending line. */
  line: number;
  fieldCount: number;
}

/**
 * Parses `text` into rows of fields.
 *
 * Handles RFC 4180 quoting: quoted fields may contain commas, newlines and `""` escapes.
 * Bare `\r\n` and `\n` terminators are both accepted, and a trailing newline does not
 * produce a phantom empty row.
 */
export function* parseCsvRows(text: string): Generator<string[]> {
  const length = text.length;
  let index = 0;
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  /** Distinguishes "no row started" from "a row whose only field is empty". */
  let rowStarted = false;

  while (index < length) {
    const char = text[index] as string;

    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        inQuotes = false;
        index += 1;
        continue;
      }
      field += char;
      index += 1;
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      rowStarted = true;
      index += 1;
      continue;
    }

    if (char === ',') {
      row.push(field);
      field = '';
      rowStarted = true;
      index += 1;
      continue;
    }

    if (char === '\n' || char === '\r') {
      // Consume `\r\n` as one terminator rather than emitting an empty row between them.
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      index += 1;
      if (rowStarted || field.length > 0 || row.length > 0) {
        row.push(field);
        yield row;
        row = [];
        field = '';
        rowStarted = false;
      }
      continue;
    }

    field += char;
    rowStarted = true;
    index += 1;
  }

  // A final row with no trailing newline still counts.
  if (rowStarted || field.length > 0 || row.length > 0) {
    row.push(field);
    yield row;
  }
}

/**
 * Yields only rows with exactly `fieldCount` fields, collecting the rest into `ragged`.
 *
 * The extract parsed at exactly 22 fields on 271,941 of 271,941 rows, so a ragged row means
 * the layout changed or the transfer was corrupted. Rows are skipped rather than coerced —
 * padding a short row would assign one field's value to another field's meaning — and the
 * caller decides whether the count of skips is tolerable.
 */
export function* parseFixedWidthRows(
  text: string,
  fieldCount: number,
  ragged: RaggedRow[],
  raggedSampleLimit = 20,
): Generator<string[]> {
  let line = 0;
  for (const row of parseCsvRows(text)) {
    line += 1;
    if (row.length !== fieldCount) {
      if (ragged.length < raggedSampleLimit) ragged.push({ line, fieldCount: row.length });
      continue;
    }
    yield row;
  }
}
