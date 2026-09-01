/**
 * The traps this parser exists for, pinned.
 *
 * The DBPR extract has no header row, so there is nothing to validate a mis-parse against —
 * a field-shift produces plausible garbage rather than an error. These tests are the only
 * thing standing between that and the published dataset.
 */
import { describe, expect, it } from 'vitest';
import { decodeLatin1, parseCsvRows, parseFixedWidthRows, type RaggedRow } from './csv';
import { EXPECTED_FIELD_COUNT } from './config';

/** A verbatim row from the live extract, 2026-09-01. */
const REAL_ROW =
  '"06","CBC","WALTERS, DENNIS D","BUILDING CONCEPTS OF TAMPA BAY, LLC","","6635 GLENCOE DRIVE","","","TAMPA","FL","33617","39","0006231","C","A","","09/16/2024","08/31/2028","","","CBC006231",""';

describe('parseCsvRows', () => {
  it('keeps a comma inside a quoted licensee name in one field', () => {
    /**
     * The whole reason a real parser is mandatory. Licensees are written `LAST, FIRST M`, so
     * splitting on commas would shift every field after the name by one — the county code
     * would be read out of the ZIP column, and a Seminole filter would silently return
     * nothing while looking like it worked.
     */
    const [row] = [...parseCsvRows(REAL_ROW)];
    expect(row).toHaveLength(EXPECTED_FIELD_COUNT);
    expect(row?.[2]).toBe('WALTERS, DENNIS D');
    expect(row?.[11]).toBe('39');
    expect(row?.[20]).toBe('CBC006231');
  });

  it('treats the first line as data, since the extract has no header', () => {
    const rows = [...parseCsvRows(`${REAL_ROW}\n${REAL_ROW}`)];
    expect(rows).toHaveLength(2);
    expect(rows[0]?.[1]).toBe('CBC');
  });

  it('unescapes a doubled quote', () => {
    const [row] = [...parseCsvRows('"MCFADDEN""S ROOFING","x"')];
    expect(row?.[0]).toBe('MCFADDEN"S ROOFING');
  });

  it('accepts a newline inside a quoted field', () => {
    const rows = [...parseCsvRows('"a\nb","c"')];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.[0]).toBe('a\nb');
  });

  it('handles CRLF, LF and a missing trailing newline identically', () => {
    expect([...parseCsvRows('"a","b"\r\n"c","d"')]).toHaveLength(2);
    expect([...parseCsvRows('"a","b"\n"c","d"')]).toHaveLength(2);
    // A trailing newline must not produce a phantom empty row.
    expect([...parseCsvRows('"a","b"\n')]).toHaveLength(1);
  });

  it('distinguishes an all-empty row from no row', () => {
    // Every DBPR row ends `,""`, so trailing empties are real fields and must be preserved.
    const [row] = [...parseCsvRows('"a","",""')];
    expect(row).toEqual(['a', '', '']);
  });
});

describe('parseFixedWidthRows', () => {
  it('skips a ragged row rather than padding it, and reports where', () => {
    /**
     * Padding would assign one field's value to another field's meaning. 0 of 271,941 rows
     * were ragged on 2026-09-01, so any at all is a signal worth surfacing, not absorbing.
     */
    const ragged: RaggedRow[] = [];
    const rows = [...parseFixedWidthRows(`${REAL_ROW}\n"short","row"`, EXPECTED_FIELD_COUNT, ragged)];
    expect(rows).toHaveLength(1);
    expect(ragged).toEqual([{ line: 2, fieldCount: 2 }]);
  });

  it('bounds how many ragged rows it remembers', () => {
    const ragged: RaggedRow[] = [];
    const text = Array.from({ length: 50 }, () => '"a","b"').join('\n');
    expect([...parseFixedWidthRows(text, EXPECTED_FIELD_COUNT, ragged, 5)]).toHaveLength(0);
    // A wholesale layout change must not turn the run manifest into a 271,941-entry list.
    expect(ragged).toHaveLength(5);
  });
});

describe('decodeLatin1', () => {
  it('preserves a high byte instead of substituting U+FFFD', () => {
    /**
     * The extract is latin-1. Decoding it as UTF-8 turns accented licensee names into
     * replacement characters, which then fail to match the same name from any other source.
     */
    const bytes = new Uint8Array([0x4a, 0x4f, 0x53, 0xc9]);
    expect(decodeLatin1(bytes)).toBe('JOSÉ');
    expect(decodeLatin1(bytes)).not.toContain('\uFFFD');
  });
});
