/**
 * The two things a deep-history sweep needs that a recent-months sweep does not: century
 * resolution that reaches back before 2000, and a census that accumulates rather than
 * overwrites so repeated sweeps converge on the month instead of resampling it.
 */
import { describe, expect, it } from 'vitest';
import { mergeCensusRows } from './census-union';
import { parseUsDate, resolveTwoDigitYear } from './dates';
import type { CensusRow, PermitStatusRecord } from './model';
import { HarvestRequest, StatusWorkItem } from './model';
import { estimatedRowsForMonth } from './plan-sweep';
import { rankLongestOpen, reduceToCurrent } from './reconcile-status';
import { normalizeDate } from './source-b';
import { censusMonthRowsKey, censusRowsKey, isCensusMonthRowsKey } from './storage';

describe('two-digit year resolution', () => {
  /**
   * The bug this pins: both sources pivoted on the 1996 Source A horizon, so any two-digit
   * year below 96 was read as 20xx. Source B reaches 1984 by application number, and
   * `84-00001` came back dated 2084 — a 42-year-old permit rendered as a future one, with a
   * negative open duration.
   */
  it('reads a pre-1996 two-digit year as last century, not next', () => {
    expect(resolveTwoDigitYear(84, 2026)).toBe(1984);
    expect(resolveTwoDigitYear(88, 2026)).toBe(1988);
    expect(resolveTwoDigitYear(92, 2026)).toBe(1992);
    expect(resolveTwoDigitYear(95, 2026)).toBe(1995);
    expect(resolveTwoDigitYear(96, 2026)).toBe(1996);
  });

  it('reads a current two-digit year as this century', () => {
    expect(resolveTwoDigitYear(26, 2026)).toBe(2026);
    expect(resolveTwoDigitYear(21, 2026)).toBe(2021);
    expect(resolveTwoDigitYear(0, 2026)).toBe(2000);
  });

  /** One year of slack, so a post-dated record is not reinterpreted as 1927. */
  it('allows next year but not the year after', () => {
    expect(resolveTwoDigitYear(27, 2026)).toBe(2027);
    expect(resolveTwoDigitYear(28, 2026)).toBe(1928);
  });

  /**
   * The rule is "never in the future", which holds at any reference year without being
   * revisited. From 2050, `96` is genuinely ambiguous between 1996 and 2096, and the rule
   * resolves it to the one that has actually happened.
   */
  it('never resolves to a future year, whatever the reference year', () => {
    expect(resolveTwoDigitYear(96, 2050)).toBe(1996);
    expect(resolveTwoDigitYear(96, 2026)).toBe(1996);
    expect(resolveTwoDigitYear(49, 2050)).toBe(2049);
  });

  it('parses both sources’ date renderings', () => {
    // Source B's legacy migration dated every pre-1996 permit to December 31 of its year.
    expect(parseUsDate('12/31/84', 2026)).toBe('1984-12-31');
    expect(parseUsDate('10/25/2021', 2026)).toBe('2021-10-25');
    expect(parseUsDate('6/28/96', 2026)).toBe('1996-06-28');
    expect(normalizeDate('12/31/92', 2026)).toBe('1992-12-31');
  });

  it('returns null rather than a guess for anything unparseable', () => {
    expect(parseUsDate('', 2026)).toBeNull();
    expect(parseUsDate('0//63', 2026)).toBeNull();
    expect(parseUsDate('NOT AVAILABLE', 2026)).toBeNull();
    // `Date` rolls a bad day-of-month forward into the next month rather than rejecting it,
    // so 31 February must be caught by the round-trip and not silently become 2 March.
    expect(parseUsDate('02/31/21', 2026)).toBeNull();
    expect(parseUsDate('13/01/21', 2026)).toBeNull();
  });
});

function row(rowKey: string, overrides: Partial<CensusRow> = {}): CensusRow {
  return {
    appNo: rowKey.split('|')[0] ?? '',
    description: 'R100 REROOF RESIDENTIAL',
    parcelId: '25-19-29-300-0290-0000',
    propertyAddress: '1 MAIN ST',
    cityCode: 'SANFORD',
    stateCode: 'FL',
    zipCode: '32771',
    propertySubdivision: '',
    structureSequence: '1',
    permitTypeSequence: '1',
    issueDate: '06/28/96',
    permitType: 'XBP BUILDING PERMIT',
    ownerName: 'OWNER',
    contractorName: 'ROOFER',
    valuationAmount: '5,000',
    rowKey,
    issuedOn: '1996-06-28',
    valuationUsd: 5_000,
    roofingRelevant: true,
    applicationType: 'ALL',
    month: '1996-06',
    ...overrides,
  };
}

describe('accumulating the census as a union', () => {
  /**
   * The measured behaviour this exists for: sweeping 1996-07 twice returned 765 rows both
   * times, but 720 distinct on the first pass and 704 on the second, with 40 rows the first
   * pass never showed. Keeping only the newest sweep made coverage oscillate.
   */
  it('keeps rows an earlier sweep found and a later one missed', () => {
    const first = [row('96-1|1|1'), row('96-2|1|1'), row('96-3|1|1')];
    const second = [row('96-1|1|1'), row('96-4|1|1')];

    const outcome = mergeCensusRows(first, second, 'run-2');

    expect(outcome.rows.map((entry) => entry.rowKey)).toEqual([
      '96-1|1|1',
      '96-2|1|1',
      '96-3|1|1',
      '96-4|1|1',
    ]);
    expect(outcome.added).toBe(1);
    expect(outcome.confirmed).toBe(1);
    expect(outcome.carriedOver).toBe(2);
    expect(outcome.updated).toBe(0);
  });

  it('is idempotent, so a redriven shard changes nothing', () => {
    const once = mergeCensusRows([], [row('96-1|1|1'), row('96-2|1|1')], 'run-1');
    const twice = mergeCensusRows(once.rows, [row('96-1|1|1'), row('96-2|1|1')], 'run-1');

    expect(twice.rows).toHaveLength(2);
    expect(twice.added).toBe(0);
    expect(twice.updated).toBe(0);
    expect(twice.carriedOver).toBe(0);
  });

  /**
   * Whether a row can change after issuance was left untested by the feasibility work. The
   * union answers it as a side effect, so a revision has to be counted rather than absorbed.
   */
  it('counts a revised row as updated and keeps the fresher content', () => {
    const before = mergeCensusRows([], [row('96-1|1|1', { valuationAmount: '5,000' })], 'run-1');
    const after = mergeCensusRows(
      before.rows,
      [row('96-1|1|1', { valuationAmount: '9,500', valuationUsd: 9_500 })],
      'run-2',
    );

    expect(after.updated).toBe(1);
    expect(after.added).toBe(0);
    expect(after.rows[0]?.valuationUsd).toBe(9_500);
  });

  it('preserves when a row was first seen while advancing when it was last seen', () => {
    const first = mergeCensusRows([], [row('96-1|1|1')], 'run-1');
    const second = mergeCensusRows(first.rows, [row('96-1|1|1')], 'run-2');

    expect(second.rows[0]?.firstSeenRunId).toBe('run-1');
    expect(second.rows[0]?.lastSeenRunId).toBe('run-2');
  });

  /** A stable byte layout keeps an unchanged month's ETag meaningful. */
  it('orders the merged rows deterministically regardless of arrival order', () => {
    const ascending = mergeCensusRows([], [row('96-1|1|1'), row('96-2|1|1')], 'run-1');
    const descending = mergeCensusRows([], [row('96-2|1|1'), row('96-1|1|1')], 'run-1');

    expect(ascending.rows.map((entry) => entry.rowKey)).toEqual(
      descending.rows.map((entry) => entry.rowKey),
    );
  });
});

describe('the accumulated month key', () => {
  it('is distinguishable from a per-run key', () => {
    const accumulated = censusMonthRowsKey({ applicationType: 'ALL', month: '1996-07' });
    const perRun = censusRowsKey({ runId: 'run-1', applicationType: 'ALL', month: '1996-07' });

    expect(isCensusMonthRowsKey(accumulated)).toBe(true);
    // The readers list a prefix and filter. A per-run key slipping through would double-count
    // every row it holds against the accumulated copy of the same row.
    expect(isCensusMonthRowsKey(perRun)).toBe(false);
    expect(perRun.startsWith(accumulated.replace('rows.ndjson', ''))).toBe(true);
  });
});

describe('the deep-history request contract', () => {
  it('accepts an oldest-first roofing hunt across the whole horizon', () => {
    const request = HarvestRequest.parse({
      fromMonth: '1996-01',
      toMonth: '2026-09',
      statusOrder: 'oldest',
      statusRoofingOnly: true,
      statusFromMonth: '1996-01',
      statusPermitLimit: 3_000,
    });

    expect(request.statusOrder).toBe('oldest');
    expect(request.statusRoofingOnly).toBe(true);
  });

  it('rejects an unknown ordering rather than defaulting quietly', () => {
    expect(() => HarvestRequest.parse({ statusOrder: 'ascending' })).toThrow();
  });

  /** A schedule still sends `{}`, so every new field has to stay optional. */
  it('leaves the daily incremental valid', () => {
    expect(HarvestRequest.parse({})).toEqual({});
  });

  it('carries the census roofing verdict onto the Source B worklist', () => {
    // Source B renders a human label where Source A renders the type code the roofing
    // vocabulary is defined in, so the flag has to travel rather than be re-derived.
    const item = {
      appNo: '96-1234',
      roofing: true,
      roofingMatchedBy: ['application_type' as const],
      censusIssuedOn: '1996-06-28',
      censusMonth: '1996-06',
    };
    expect(StatusWorkItem.parse(item)).toEqual(item);
    expect(() => StatusWorkItem.parse({ appNo: '96-1234', roofing: true })).toThrow();
    // The `YYYY-MM-99` ordering sentinel is not a date and must never reach the worklist.
    expect(() => StatusWorkItem.parse({ ...item, censusIssuedOn: '1996-06-99' })).toThrow();
    // An unrecognised roofing rule is a vocabulary change, not something to accept quietly.
    expect(() => StatusWorkItem.parse({ ...item, roofingMatchedBy: ['permitType'] })).toThrow();
  });

  /**
   * The month is what the sweep orders on, so it is the field that must not be absent — 7.88% of
   * census rows carry an issue date outside the month they were harvested in, and those rows
   * reach the worklist with `censusIssuedOn: null` and nothing else to sort them by.
   */
  it('requires the census month even when the issue date could not be trusted', () => {
    expect(() =>
      StatusWorkItem.parse({
        appNo: '2-10436',
        roofing: true,
        roofingMatchedBy: ['permit_type'],
        censusIssuedOn: null,
      }),
    ).toThrow();
    expect(
      StatusWorkItem.parse({
        appNo: '2-10436',
        roofing: true,
        roofingMatchedBy: ['permit_type'],
        censusIssuedOn: null,
        censusMonth: '2003-01',
      }).censusMonth,
    ).toBe('2003-01');
  });
});

describe('application numbers across eras', () => {
  /**
   * Source A renders 2000-2009 with a single-digit year and only pads to two from 2010.
   * Requiring two digits rejected every permit in that decade — caught when the status
   * worklist threw on `0-56`, `1-887` and `2-1117` after the sweep reached 2000.
   */
  it('accepts the single-digit year Source A uses for the 2000s', () => {
    for (const appNo of ['0-56', '1-887', '2-1117', '0-10006']) {
      expect(() =>
        StatusWorkItem.parse({
          appNo,
          roofing: true,
          roofingMatchedBy: ['permit_type'],
          censusIssuedOn: null,
          censusMonth: '2003-01',
        }),
      ).not.toThrow();
    }
  });

  it('still accepts the two-digit years either side of that decade', () => {
    for (const appNo of ['96-797', '98-8758', '26-12426']) {
      expect(() =>
        StatusWorkItem.parse({
          appNo,
          roofing: false,
          roofingMatchedBy: [],
          censusIssuedOn: null,
          censusMonth: '1996-01',
        }),
      ).not.toThrow();
    }
  });

  it('rejects anything that is not a year and a sequence', () => {
    for (const appNo of ['2000-56', '-56', '123-56', '96-', 'AB-12']) {
      expect(() =>
        StatusWorkItem.parse({ appNo, roofing: false, censusIssuedOn: null }),
      ).toThrow();
    }
  });
});

describe('the row-volume estimate', () => {
  /**
   * A flat 2025-derived rate overstated the 1990s threefold, which for a 369-month backfill
   * is a materially wrong figure in the cost gate and the ETA.
   */
  it('scales with the era rather than assuming every month is a 2025 month', () => {
    expect(estimatedRowsForMonth('1996-06')).toBeLessThan(estimatedRowsForMonth('2000-06'));
    expect(estimatedRowsForMonth('2000-06')).toBeLessThan(estimatedRowsForMonth('2025-06'));
  });
});

function statusRecord(overrides: Partial<PermitStatusRecord>): PermitStatusRecord {
  return {
    runId: 'run-1',
    appNo: '96-1234',
    parcelId: '25-19-29-300-0290-0000',
    address: '1 MAIN ST',
    applicationDate: '1996-06-28',
    applicationType: 'REROOF RESIDENTIAL',
    owner: 'OWNER',
    tenantName: null,
    generalContractor: 'ROOFER',
    zoningDescription: null,
    valuationUsd: 5_000,
    squareFootage: null,
    rawStatus: 'PERMIT ISSUED',
    canonicalStatus: 'issued',
    lifecycle: 'open',
    terminal: false,
    harvestedAt: '2026-09-01T12:00:00.000Z',
    roofingRelevant: true,
    roofingMatchedBy: ['application_type'],
    censusIssuedOn: '1996-06-28',
    closedDate: null,
    closedDateSource: 'unavailable',
    openDurationDays: 11_000,
    openDurationBasis: 'still_open',
    inspections: [],
    statusRawKey: 'raw/permits/source-b/app=96-1234/run=run-1/status.html',
    inspectionsRawKey: null,
    ...overrides,
  };
}

describe('the long-open leaderboard', () => {
  it('ranks still-open permits longest-first', () => {
    const ranked = rankLongestOpen([
      statusRecord({ appNo: 'recent', openDurationDays: 30 }),
      statusRecord({ appNo: 'ancient', openDurationDays: 11_000 }),
      statusRecord({ appNo: 'middling', openDurationDays: 900 }),
    ]);

    expect(ranked.map((permit) => permit.appNo)).toEqual(['ancient', 'middling', 'recent']);
    expect(ranked[0]?.openDurationYears).toBeCloseTo(30.1, 1);
  });

  it('excludes closed permits and permits whose duration is unknown', () => {
    const ranked = rankLongestOpen([
      statusRecord({ appNo: 'open', openDurationBasis: 'still_open', openDurationDays: 500 }),
      statusRecord({
        appNo: 'closed',
        terminal: true,
        openDurationBasis: 'closed',
        openDurationDays: 9_000,
      }),
      // A quarantined status is not known to be open. Including it would put a permit nobody
      // has classified at the top of the leaderboard.
      statusRecord({
        appNo: 'unmapped',
        openDurationBasis: 'unknown',
        openDurationDays: null,
        canonicalStatus: 'unknown',
      }),
    ]);

    expect(ranked.map((permit) => permit.appNo)).toEqual(['open']);
  });

  /**
   * Status accumulates differently from the census on purpose. A census row is a fact, so
   * repeated sweeps union. A status is an observation that expires, so repeated sweeps reduce
   * to the newest — unioning them would leave a permit both open and closed at once.
   */
  it('keeps the newest observation of a permit, not the union of them', () => {
    const current = reduceToCurrent([
      {
        observedAt: '2026-01-01T00:00:00.000Z',
        record: statusRecord({
          appNo: '05-1234',
          rawStatus: 'PERMIT ISSUED',
          terminal: false,
          openDurationBasis: 'still_open',
        }),
      },
      {
        observedAt: '2026-09-01T00:00:00.000Z',
        record: statusRecord({
          appNo: '05-1234',
          rawStatus: 'CLOSED',
          terminal: true,
          openDurationBasis: 'closed',
        }),
      },
    ]);

    expect(current).toHaveLength(1);
    expect(current[0]?.rawStatus).toBe('CLOSED');
    // And so it drops off the open leaderboard rather than lingering on it.
    expect(rankLongestOpen(current)).toHaveLength(0);
  });

  it('does not let an older observation overwrite a newer one, whatever the read order', () => {
    const newer = {
      observedAt: '2026-09-01T00:00:00.000Z',
      record: statusRecord({
        appNo: '05-1234',
        rawStatus: 'CLOSED',
        terminal: true,
        openDurationBasis: 'closed',
      }),
    };
    const older = {
      observedAt: '2026-01-01T00:00:00.000Z',
      record: statusRecord({ appNo: '05-1234', rawStatus: 'PERMIT ISSUED' }),
    };

    expect(reduceToCurrent([newer, older])[0]?.rawStatus).toBe('CLOSED');
    expect(reduceToCurrent([older, newer])[0]?.rawStatus).toBe('CLOSED');
  });

  /**
   * The exact inversion the observation-time ordering exists to prevent, with the real run ids
   * and write times measured off the bucket. Ordering on the record's own `harvestedAt` — which
   * no staged object carries — degenerated to this lexicographic run-id comparison, and
   * `verify-closed` > `roof-hunt-r12` as a string while being three hours older as an object.
   */
  it('ranks by write time even when the older run id sorts higher lexicographically', () => {
    const observations = [
      {
        observedAt: '2026-09-01T17:38:41.000Z',
        record: statusRecord({
          appNo: '99-6582',
          runId: 'verify-closed',
          rawStatus: 'CLOSED',
          terminal: true,
          openDurationBasis: 'closed',
        }),
      },
      {
        observedAt: '2026-09-01T18:39:45.000Z',
        record: statusRecord({
          appNo: '99-6582',
          runId: 'roof-hunt-r12',
          rawStatus: 'PERMIT ISSUED',
          terminal: false,
          openDurationBasis: 'still_open',
        }),
      },
    ];

    expect(reduceToCurrent(observations)[0]?.runId).toBe('roof-hunt-r12');
    expect(reduceToCurrent([...observations].reverse())[0]?.runId).toBe('roof-hunt-r12');
  });

  it('breaks a same-instant tie deterministically', () => {
    const observedAt = '2026-09-01T00:00:00.000Z';
    const a = { observedAt, record: statusRecord({ appNo: '05-1', runId: 'run-a', rawStatus: 'A' }) };
    const b = { observedAt, record: statusRecord({ appNo: '05-1', runId: 'run-b', rawStatus: 'B' }) };

    expect(reduceToCurrent([a, b])[0]?.rawStatus).toBe('B');
    expect(reduceToCurrent([b, a])[0]?.rawStatus).toBe('B');
  });

  it('reports the last inspection result, which is when anything last happened', () => {
    const ranked = rankLongestOpen([
      statusRecord({
        inspections: [
          { inspectionType: 'ROOF DRY IN', scheduledDate: '2007-02-01', status: 'A', resultDate: '2007-02-03', permitDescription: 'REROOF' },
          { inspectionType: 'FINAL ROOF', scheduledDate: '2007-03-01', status: 'S', resultDate: null, permitDescription: 'REROOF' },
        ],
      }),
    ]);

    expect(ranked[0]?.inspectionCount).toBe(2);
    expect(ranked[0]?.lastInspectionResultDate).toBe('2007-02-03');
  });
});
