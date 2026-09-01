import { describe, expect, it } from 'vitest';
import {
  FDOR_COUNTY_CODE,
  FDOR_FIELDS,
  FDOR_MAX_RECORD_COUNT,
  FDOR_OBJECTID_WINDOW,
  FDOR_RECORD_COUNT_MAX,
  FDOR_RECORD_COUNT_MIN,
  OBSERVED_FDOR_RECORD_COUNT,
  fdorQueryUrl,
  fdorSnapshotToken,
  fdorWindowWhere,
  objectIdWindows,
} from './fdor';

/** Seminole's live `OBJECTID` range, measured on 2026-09-01. */
const SEMINOLE_LO = 9_508_715;
const SEMINOLE_HI = 9_689_308;

describe('objectIdWindows', () => {
  it('covers the county in the measured number of requests', () => {
    const windows = objectIdWindows(SEMINOLE_LO, SEMINOLE_HI);
    // 180,594 ids at 1,500 per window. The measured full extract took 121 requests.
    expect(windows).toHaveLength(121);
  });

  it('produces half-open windows so no id is claimed twice', () => {
    const windows = objectIdWindows(0, 9, 5);
    expect(windows).toEqual([
      { lo: 0, hi: 5 },
      { lo: 5, hi: 10 },
    ]);
  });

  it('includes the maximum id', () => {
    const windows = objectIdWindows(SEMINOLE_LO, SEMINOLE_HI);
    const last = windows.at(-1);
    expect(last?.hi).toBeGreaterThan(SEMINOLE_HI);
    expect(windows[0]?.lo).toBe(SEMINOLE_LO);
  });

  it('handles a single-id range', () => {
    expect(objectIdWindows(7, 7, 1500)).toEqual([{ lo: 7, hi: 8 }]);
  });

  it('keeps every window comfortably under the service page ceiling', () => {
    // Not a proof — id density could change on a republish, which is why the fetcher
    // retains a `resultOffset` fallback — but at the measured density of 179,107 rows
    // across 180,594 ids a 1,500-wide window cannot approach 2,000 rows.
    expect(FDOR_OBJECTID_WINDOW).toBeLessThan(FDOR_MAX_RECORD_COUNT);
  });

  it('rejects an inverted or non-finite range rather than returning nothing', () => {
    expect(() => objectIdWindows(10, 1)).toThrow(RangeError);
    expect(() => objectIdWindows(Number.NaN, 10)).toThrow(RangeError);
    expect(() => objectIdWindows(1, 10, 0)).toThrow(RangeError);
  });
});

describe('fdorWindowWhere', () => {
  it('repeats the county filter on every window', () => {
    // The id range alone is not a county filter. A republish that interleaves counties
    // would otherwise pull Orange parcels into a Seminole window.
    expect(fdorWindowWhere({ lo: 100, hi: 200 })).toBe(
      'CO_NO=69 AND OBJECTID>=100 AND OBJECTID<200',
    );
  });

  it('uses 69 for Seminole, not 59', () => {
    // 59 is Osceola. FDOR's own NAL filenames publish Seminole as 58, which is Orange.
    expect(FDOR_COUNTY_CODE).toBe(69);
  });
});

describe('fdorQueryUrl', () => {
  it('encodes the where clause', () => {
    const url = fdorQueryUrl({ where: 'CO_NO=69 AND OBJECTID>=1', f: 'json' });
    expect(url).toContain('/FeatureServer/0/query?');
    expect(url).toContain('where=CO_NO%3D69%20AND%20OBJECTID%3E%3D1');
  });
});

describe('fdorSnapshotToken', () => {
  it('changes when the layer is republished', () => {
    const before = fdorSnapshotToken(1_780_974_574_367, 179_107);
    expect(before).not.toBe(fdorSnapshotToken(1_800_000_000_000, 179_107));
  });

  it('changes when the record count moves under an unchanged edit date', () => {
    const before = fdorSnapshotToken(1_780_974_574_367, 179_107);
    expect(before).not.toBe(fdorSnapshotToken(1_780_974_574_367, 179_200));
  });

  it('is stable for an unchanged layer', () => {
    expect(fdorSnapshotToken(1_780_974_574_367, 179_107)).toBe(
      fdorSnapshotToken(1_780_974_574_367, 179_107),
    );
  });
});

describe('the field projection', () => {
  it('carries the join key, the qualification gate, and the FDOR-only enrichment', () => {
    for (const field of ['PARCEL_ID', 'CO_NO', 'QUAL_CD1', 'NCONST_VAL', 'CENSUS_BK']) {
      expect(FDOR_FIELDS).toContain(field);
    }
  });

  it('stays a projection rather than the whole 120-field layer', () => {
    expect(FDOR_FIELDS.length).toBeLessThan(60);
    expect(new Set(FDOR_FIELDS).size).toBe(FDOR_FIELDS.length);
  });
});

describe('the record-count band', () => {
  it('brackets the measured county size', () => {
    expect(FDOR_RECORD_COUNT_MIN).toBeLessThan(OBSERVED_FDOR_RECORD_COUNT);
    expect(FDOR_RECORD_COUNT_MAX).toBeGreaterThan(OBSERVED_FDOR_RECORD_COUNT);
  });

  it('excludes a neighbouring county, which is what a CO_NO remap would return', () => {
    // Lee (`CO_NO=46`) holds 556,100 records from the same layer.
    expect(556_100).toBeGreaterThan(FDOR_RECORD_COUNT_MAX);
  });
});
