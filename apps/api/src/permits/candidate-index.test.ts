import { describe, expect, it } from 'vitest';
import {
  fingerprintMonthShards,
  parseCandidateNdjson,
  serializeCandidates,
} from './candidate-index';
import { isCensusMonthRowsKey, roofingCandidateIndexKey } from './storage';

describe('roofing candidate index', () => {
  it('does not treat the index object as a census month shard', () => {
    expect(isCensusMonthRowsKey(roofingCandidateIndexKey())).toBe(false);
    expect(
      isCensusMonthRowsKey('staged/permits/census/month=1996-01/type=ALL/rows.ndjson'),
    ).toBe(true);
  });

  it('changes fingerprint when a month shard is rewritten', () => {
    const first = fingerprintMonthShards([
      { key: 'staged/permits/census/month=1996-01/type=ALL/rows.ndjson', lastModified: '2026-09-01T00:00:00.000Z' },
    ]);
    const rewritten = fingerprintMonthShards([
      { key: 'staged/permits/census/month=1996-01/type=ALL/rows.ndjson', lastModified: '2026-09-02T00:00:00.000Z' },
    ]);
    expect(first).not.toBe(rewritten);
  });

  it('round-trips the worklist', () => {
    const records = serializeCandidates([
      {
        appNo: '99-1',
        earliestAge: '1999-01-02',
        latestAge: '1999-01-02',
        roofingMatchedBy: ['permit_type'],
        earliestTrustedIssue: '1999-01-02',
        earliestMonth: '1999-01',
      },
      {
        appNo: '96-2',
        earliestAge: '1996-01-99',
        latestAge: '1996-01-99',
        roofingMatchedBy: ['description'],
        earliestTrustedIssue: null,
        earliestMonth: '1996-01',
      },
    ]);
    const body = records.map((record) => JSON.stringify(record)).join('\n');
    expect(parseCandidateNdjson(body).map((record) => record.appNo)).toEqual(['96-2', '99-1']);
  });
});
