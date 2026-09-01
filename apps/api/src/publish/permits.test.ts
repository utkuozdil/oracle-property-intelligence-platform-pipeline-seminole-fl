import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { normaliseParcelId, PARCEL_ID } from '../permits/reconcile-census';
import { applicationCodeOf } from '../permits/source-a';
import { queryRow } from './duckdb';
import {
  absenceMeaning,
  analyseMonthCoverage,
  APPLICATION_TYPE_CODE_SQL,
  bbbLookupFor,
  CENSUS_PARCEL_ID_SQL,
  openYears,
  publishedStatus,
  reduceToCurrentObservation,
  WELL_FORMED_PARCEL_ID_SQL,
  type StatusObservation,
} from './permits';
import {
  mergePermitPointer,
  permitPointerBlock,
  type PermitPublicationRecord,
} from './permit-pointer';

function observation(overrides: Partial<StatusObservation>): StatusObservation {
  return {
    appNo: '1-1442',
    runId: 'roof-hunt-r1',
    observedAt: '2026-09-01T15:34:44.000Z',
    parcelId: '20-21-31-300-0110-0000',
    applicationDate: '2001-02-21',
    applicationType: 'SIDING / ROOF OVER',
    lifecycle: 'open',
    rawStatus: 'PERMIT ISSUED',
    canonicalStatus: 'active',
    terminal: false,
    roofingRelevant: true,
    generalContractor: 'HERNANDO FIRE & SAFETY EQUIP',
    tenantName: null,
    owner: null,
    address: '2041 W SR 426',
    closedDate: null,
    openDurationDays: 9323,
    openDurationBasis: 'still_open',
    ...overrides,
  };
}

describe('reduceToCurrentObservation', () => {
  it('keeps the newest observation of an application', () => {
    const current = reduceToCurrentObservation([
      observation({
        observedAt: '2026-09-01T14:38:41.000Z',
        runId: 'verify-closed',
        rawStatus: 'OLD',
      }),
      observation({
        observedAt: '2026-09-01T15:39:45.000Z',
        runId: 'roof-hunt-r12',
        rawStatus: 'NEW',
      }),
    ]);

    expect(current).toHaveLength(1);
    expect(current[0]?.rawStatus).toBe('NEW');
  });

  /**
   * The failure this reduction exists to avoid. `verify-closed` sorts after every `roof-hunt-*`
   * run, but its objects are the oldest in the status prefix, so any reduction that falls back to
   * the run id publishes a permit's first observed status as its current one.
   */
  it('is not fooled by a run id that sorts later than a newer run', () => {
    const current = reduceToCurrentObservation([
      observation({
        observedAt: '2026-09-01T15:39:45.000Z',
        runId: 'roof-hunt-r12',
        lifecycle: 'closed',
      }),
      observation({
        observedAt: '2026-09-01T14:38:41.000Z',
        runId: 'verify-closed',
        lifecycle: 'open',
      }),
    ]);

    expect(current[0]?.lifecycle).toBe('closed');
  });

  it('breaks a tie on the run id, so the output is deterministic', () => {
    const [first] = reduceToCurrentObservation([
      observation({ runId: 'roof-hunt-r1', rawStatus: 'A' }),
      observation({ runId: 'roof-hunt-r2', rawStatus: 'B' }),
    ]);

    expect(first?.rawStatus).toBe('B');
  });

  it('orders the output by application number, so two runs produce identical bytes', () => {
    const current = reduceToCurrentObservation([
      observation({ appNo: '4-2349' }),
      observation({ appNo: '0-266' }),
      observation({ appNo: '1-1442' }),
    ]);

    expect(current.map((entry) => entry.appNo)).toEqual(['0-266', '1-1442', '4-2349']);
  });
});

describe('publishedStatus', () => {
  it('publishes an open permit with a trusted duration', () => {
    expect(publishedStatus({ lifecycle: 'open', openDurationBasis: 'still_open' })).toEqual({
      status: 'open',
      durationTrusted: true,
    });
  });

  // An unmapped raw status is quarantined by the permits tier and is not known to be open, so
  // its duration must not reach an operator as a multi-year lead.
  it('withholds the duration when the basis does not corroborate the lifecycle', () => {
    expect(publishedStatus({ lifecycle: 'open', openDurationBasis: 'unknown' })).toEqual({
      status: 'open',
      durationTrusted: false,
    });
  });

  it('never trusts a duration on a void permit', () => {
    expect(publishedStatus({ lifecycle: 'void', openDurationBasis: 'still_open' })).toEqual({
      status: 'void',
      durationTrusted: false,
    });
  });

  it('maps an unrecognised lifecycle to unknown rather than guessing closed', () => {
    expect(publishedStatus({ lifecycle: 'something-new', openDurationBasis: 'closed' })).toEqual({
      status: 'unknown',
      durationTrusted: false,
    });
  });
});

describe('openYears', () => {
  it('converts the source\u2019s own day count at two decimals', () => {
    expect(openYears(9323)).toBe(25.52);
    expect(openYears(1096)).toBe(3);
  });
});

describe('bbbLookupFor', () => {
  // Three states rather than a nullable rating: "BBB has no profile" and "nobody looked" are
  // different facts, and the demo script asks for the rating "where available".
  it('distinguishes never-searched from searched-and-not-found', () => {
    expect(bbbLookupFor(undefined)).toBe('not_searched');
    expect(bbbLookupFor({ matched: false, rating: null })).toBe('searched_no_match');
  });

  it('distinguishes a matched business with no grade from a graded one', () => {
    expect(bbbLookupFor({ matched: true, rating: null })).toBe('matched_unrated');
    expect(bbbLookupFor({ matched: true, rating: 'A+' })).toBe('rated');
  });
});

describe('analyseMonthCoverage', () => {
  it('reports a contiguous window with no holes', () => {
    const coverage = analyseMonthCoverage(['1996-11', '1996-12', '1997-01']);

    expect(coverage).toEqual({
      months: 3,
      firstMonth: '1996-11',
      lastMonth: '1997-01',
      contiguous: true,
      missingMonths: [],
    });
  });

  // A month count alone cannot tell 294 contiguous months from 294 scattered across four
  // decades, and the two license completely different claims about a parcel with no permits.
  it('names the holes inside the window rather than implying them from a total', () => {
    const coverage = analyseMonthCoverage(['2015-11', '2016-02', '2015-12']);

    expect(coverage.contiguous).toBe(false);
    expect(coverage.missingMonths).toEqual(['2016-01']);
  });

  it('crosses a year boundary correctly', () => {
    expect(analyseMonthCoverage(['1999-12', '2000-01']).contiguous).toBe(true);
  });

  it('deduplicates months, so a re-listed object cannot inflate the count', () => {
    expect(analyseMonthCoverage(['2001-01', '2001-01']).months).toBe(1);
  });

  it('treats an empty sweep as an empty window rather than throwing', () => {
    expect(analyseMonthCoverage([])).toEqual({
      months: 0,
      firstMonth: null,
      lastMonth: null,
      contiguous: true,
      missingMonths: [],
    });
  });
});

describe('absenceMeaning', () => {
  it('bounds the claim to the harvested window', () => {
    const sentence = absenceMeaning(analyseMonthCoverage(['1996-01', '1996-02']));

    expect(sentence).toContain('between 1996-01 and 1996-02');
    expect(sentence).toContain('has not harvested yet');
  });

  it('points at the named holes when the window is not contiguous', () => {
    const sentence = absenceMeaning(analyseMonthCoverage(['1996-01', '1996-03']));

    expect(sentence).toContain('missingMonths');
  });

  it('refuses to imply anything when nothing has been harvested', () => {
    expect(absenceMeaning(analyseMonthCoverage([]))).toContain('carries no information at all');
  });
});

describe('permit pointer', () => {
  const record = {
    schema: 'oracle/permits/1',
    runId: 'permits-abc123',
    referenceDate: '2026-09-01T15:39:45.000Z',
    publishedAt: '2026-09-01T16:00:00.000Z',
    prefix: 'publish/permits/snapshot=permits-abc123/',
    files: {
      manifest: {
        file: 'manifest.json',
        key: 'publish/permits/snapshot=permits-abc123/manifest.json',
        bytes: 1,
        rows: 0,
      },
      permits: {
        file: 'permits.parquet',
        key: 'publish/permits/snapshot=permits-abc123/permits.parquet',
        bytes: 2,
        rows: 388289,
      },
      parcelIndex: {
        file: 'parcel-index.parquet',
        key: 'publish/permits/snapshot=permits-abc123/parcel-index.parquet',
        bytes: 3,
        rows: 71077,
      },
      contractors: {
        file: 'contractors.parquet',
        key: 'publish/permits/snapshot=permits-abc123/contractors.parquet',
        bytes: 4,
        rows: 13508,
      },
    },
    coverage: {
      census: {
        months: 294,
        firstMonth: '1996-01',
        lastMonth: '2020-06',
        contiguous: true,
        missingMonths: [],
      },
    },
    counts: { permitRows: 388289, publishedParcels: 71077, applicationsWithStatus: 124 },
  } as unknown as PermitPublicationRecord;

  it('announces availability and where to read, without restating coverage prose', () => {
    const block = permitPointerBlock(record);

    expect(block.available).toBe(true);
    expect(block.permitsKey).toBe('publish/permits/snapshot=permits-abc123/permits.parquet');
    expect(block.coverage).toEqual({
      firstMonth: '1996-01',
      lastMonth: '2020-06',
      months: 294,
      complete: false,
      statusKnownApplications: 124,
    });
  });

  // The parcel pointer is written by the snapshot publish step, which this tier does not own, so
  // the merge has to preserve fields this tier has never heard of.
  it('preserves every existing field of the parcel pointer', () => {
    const pointer = {
      runId: 'recon-verify-1788271882',
      parcelCount: 181218,
      somethingAddedLater: { nested: true },
    };

    const merged = mergePermitPointer(pointer, permitPointerBlock(record));

    expect(merged.runId).toBe('recon-verify-1788271882');
    expect(merged.parcelCount).toBe(181218);
    expect(merged.somethingAddedLater).toEqual({ nested: true });
    expect((merged.permits as { available: boolean }).available).toBe(true);
  });

  it('replaces a previous permits block rather than nesting one inside it', () => {
    const merged = mergePermitPointer(
      { permits: { available: true, runId: 'permits-old' } },
      permitPointerBlock(record),
    );

    expect((merged.permits as { runId: string }).runId).toBe('permits-abc123');
  });
});

/**
 * The SQL transcriptions of the permits tier's parcel-id handling, held equivalent to the
 * originals.
 *
 * The join runs inside DuckDB over 388,289 rows, so the normalisation had to be expressed as
 * SQL; this is what stops that from becoming a second, divergent definition. `normaliseParcelId`
 * and `PARCEL_ID` are imported rather than copied, so a change to either fails here.
 *
 * Skipped when DuckDB is not on PATH. The engine is a hard requirement of this tier at runtime
 * — `./duckdb` shells out to the same binary the demo queries with — but a lint-and-test
 * container need not carry it, and a suite that cannot run is worse than one that says so.
 */
const duckdbAvailable = ((): boolean => {
  try {
    execFileSync(process.env.DUCKDB_BIN ?? 'duckdb', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!duckdbAvailable)('parcel id SQL matches the permits tier', () => {
  /**
   * Real Seminole renderings. The last four are the ones the permits tier documents as having
   * been silently rejected by an earlier, all-numeric pattern — 44% of the county.
   */
  const ids = [
    '08-21-29-524-0000-1100',
    '25-19-29-300-0290-0000',
    '20-21-31-300-0110-0000',
    '27-21-31-300-039C-0000',
    '01-20-29-5MF-0000-0100',
    '00-00-00-ROW-0000-0000',
    '01-20-29-505-0S00-0000',
    '21-20-30-5AP-0000-064S',
  ];

  const malformed = ['0821295240000110', '8-21-29-524-0000-1100', '08-21-29-524-0000-110', ''];

  it('normalises every rendering exactly as normaliseParcelId does', () => {
    const values = [...ids, ...malformed].map((id) => `('${id}')`).join(', ');
    const row = queryRow<{ payload: { id: string; sql: string }[] }>(
      `SELECT to_json(list({'id': id, 'sql': ${CENSUS_PARCEL_ID_SQL('id')}} ORDER BY id)) AS payload
       FROM (VALUES ${values}) AS t(id);`,
    );

    for (const { id, sql } of row.payload) {
      expect(sql, `normalisation of "${id}"`).toBe(normaliseParcelId(id));
    }
  });

  it('accepts and rejects exactly what PARCEL_ID does', () => {
    const values = [...ids, ...malformed].map((id) => `('${id}')`).join(', ');
    const row = queryRow<{ payload: { id: string; ok: boolean }[] }>(
      `SELECT to_json(list({'id': id, 'ok': ${WELL_FORMED_PARCEL_ID_SQL('id')}} ORDER BY id)) AS payload
       FROM (VALUES ${values}) AS t(id);`,
    );

    for (const { id, ok } of row.payload) {
      expect(ok, `well-formedness of "${id}"`).toBe(PARCEL_ID.test(id));
    }
  });

  it('produces the 17-character bare form the published snapshot stores', () => {
    for (const id of ids) {
      expect(normaliseParcelId(id)).toHaveLength(17);
    }
  });

  /**
   * The application-type code is what decides whether a permit is roofing work, in this tier and
   * in the consumer, so a transcription that drifted would silently reclassify the demo
   * population.
   */
  it('extracts the application-type code exactly as applicationCodeOf does', () => {
    const descriptions = [
      'R100 REROOF RESIDENTIAL',
      'A996 FENCE/WALL RESIDENTIAL',
      'A998 SIDING / ROOF OVER',
      'C998 SIDING/AWNINGS/AL ROOF/CANOPY COMMERCIAL',
      'EZRO EZ REROOF RESIDENTIAL',
      'R80 SHORT CODE',
      'NOCODE',
      '',
    ];

    const values = descriptions.map((description) => `('${description}')`).join(', ');
    const row = queryRow<{ payload: { text: string; sql: string }[] }>(
      `SELECT to_json(list({'text': t.text, 'sql': ${APPLICATION_TYPE_CODE_SQL('t.text')}} ORDER BY t.text)) AS payload
       FROM (VALUES ${values}) AS t(text);`,
    );

    for (const { text, sql } of row.payload) {
      // DuckDB's `regexp_extract` returns an empty string where the TypeScript returns null.
      expect(sql === '' ? null : sql, `application code of "${text}"`).toBe(
        applicationCodeOf(text),
      );
    }
  });
});
