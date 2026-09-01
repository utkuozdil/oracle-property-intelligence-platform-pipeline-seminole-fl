/**
 * The single pass over the 48.8 MB extract.
 *
 * One pass, and it retains almost nothing. 271,941 rows materialised as parsed records would
 * cost hundreds of megabytes of Lambda memory for a run that needs the 5,211 Seminole rows
 * and, at most, a handful of out-of-county ones. So the row generator is consumed lazily and
 * a row is only converted into a `LicenceRecord` if something is going to keep it.
 */
import { EXPECTED_FIELD_COUNT, FIELD, JOIN_COUNTY_CODES, MIN_PLAUSIBLE_RECORDS } from './config';
import { parseFixedWidthRows, type RaggedRow } from './csv';
import { ImplausibleExtractError } from './http';
import type { LicenceRecord } from './model';
import { parseLicenceRow } from './parse';

export interface ExtractParseResult {
  /** Every licence in the target counties; see `JOIN_COUNTY_CODES`. */
  countyRecords: LicenceRecord[];
  /**
   * Out-of-county records whose licence serial a permit contractor named outright.
   *
   * Kept because a contractor who pulls Seminole permits need not hold a Seminole-registered
   * licence — `NOLANDS ROOFING (CCC-1335461)` is registered in Lake County (code `45`) — and
   * a plain county filter silently drops them. Scoped to serials the permit data actually
   * references, so this costs a couple of records rather than the whole state.
   */
  outOfCountyRecords: LicenceRecord[];
  rowsParsed: number;
  raggedRows: RaggedRow[];
  /** Licence-type prefixes seen anywhere in the file, for qualifier parsing. */
  licencePrefixes: Set<string>;
  countyCodeCounts: Map<string, number>;
}

function serialFromRow(row: readonly string[]): string | null {
  const serial = (row[FIELD.licenceSerial] ?? '').trim().replace(/^0+/, '');
  return serial.length > 0 ? serial : null;
}

/**
 * Parses the extract, keeping the county population and any explicitly referenced
 * out-of-county serials.
 *
 * `asOf` is threaded through to `deriveStanding` so every record in a run is judged against
 * one instant — otherwise a licence expiring today could be `expired` at the top of the file
 * and `expiring_soon` at the bottom.
 */
export function parseExtract(options: {
  text: string;
  sourceUrl: string;
  fetchedAt: string;
  asOf: Date;
  countyCodes?: ReadonlySet<string>;
  wantedSerials?: ReadonlySet<string>;
}): ExtractParseResult {
  const countyCodes = options.countyCodes ?? JOIN_COUNTY_CODES;
  const wantedSerials = options.wantedSerials ?? new Set<string>();
  const context = {
    sourceUrl: options.sourceUrl,
    fetchedAt: options.fetchedAt,
    asOf: options.asOf,
  };

  const countyRecords: LicenceRecord[] = [];
  const outOfCountyRecords: LicenceRecord[] = [];
  const raggedRows: RaggedRow[] = [];
  const licencePrefixes = new Set<string>();
  const countyCodeCounts = new Map<string, number>();
  let rowsParsed = 0;

  for (const row of parseFixedWidthRows(options.text, EXPECTED_FIELD_COUNT, raggedRows)) {
    rowsParsed += 1;
    licencePrefixes.add((row[FIELD.licenceTypePrefix] ?? '').trim());

    const rowCounty = (row[FIELD.countyCode] ?? '').trim();
    countyCodeCounts.set(rowCounty, (countyCodeCounts.get(rowCounty) ?? 0) + 1);

    if (countyCodes.has(rowCounty)) {
      countyRecords.push(parseLicenceRow(row, context));
      continue;
    }

    if (wantedSerials.size > 0) {
      const serial = serialFromRow(row);
      if (serial !== null && wantedSerials.has(serial)) {
        outOfCountyRecords.push(parseLicenceRow(row, context));
      }
    }
  }

  /**
   * A file that suddenly yields a fraction of the observed 271,941 rows has changed shape or
   * was truncated in transit. Failing here matters because the alternative is overwriting
   * `current.json` with a dataset that is quietly a tenth of the size.
   */
  if (rowsParsed < MIN_PLAUSIBLE_RECORDS) {
    throw new ImplausibleExtractError(
      `parsed only ${rowsParsed} rows, below the ${MIN_PLAUSIBLE_RECORDS} floor ` +
        '(271,941 observed on 2026-09-01) — the extract layout or transfer is wrong',
    );
  }

  return {
    countyRecords,
    outOfCountyRecords,
    rowsParsed,
    raggedRows,
    licencePrefixes,
    countyCodeCounts,
  };
}
