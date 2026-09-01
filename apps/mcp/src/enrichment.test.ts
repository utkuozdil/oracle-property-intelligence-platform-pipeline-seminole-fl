import { describe, expect, it } from 'vitest';
import {
  contractorKey,
  describeEnrichment,
  needsS3,
  normaliseParcelId,
  permitsCte,
} from './enrichment';

describe('normaliseParcelId', () => {
  it('reconciles the permit spelling with the published spelling', () => {
    expect(normaliseParcelId('15-21-29-527-0000-0140')).toBe('15212952700000140');
    expect(normaliseParcelId('28-19-30-5NQ-0000-0040')).toBe('2819305NQ00000040');
  });

  it('leaves an already-stripped id alone', () => {
    expect(normaliseParcelId('2819305NQ00000040')).toBe('2819305NQ00000040');
  });
});

describe('describeEnrichment', () => {
  it('reports permits as unavailable, with a reason, when nothing is configured', () => {
    const status = describeEnrichment({ permitStatusUri: null, bbbPointerUri: null });
    expect(status.permits.available).toBe(false);
    expect(status.bbb.available).toBe(false);
    // The specific failure this guards against: a consumer reading an empty permit list
    // as "this property has no permits".
    expect(status.permits.reason).toContain('not "no permits"');
  });

  it('still qualifies the answer when a sweep is configured', () => {
    const status = describeEnrichment({
      permitStatusUri: 's3://bucket/staged/permits/status/run=x/batch-0000.ndjson',
      bbbPointerUri: null,
    });
    expect(status.permits.available).toBe(true);
    expect(status.permits.reason).toContain('not the whole county');
  });
});

describe('needsS3', () => {
  it('is false when nothing is configured, so no AWS extension is loaded', () => {
    expect(needsS3({ permitStatusUri: null, bbbPointerUri: null })).toBe(false);
  });

  it('is false for local files', () => {
    expect(needsS3({ permitStatusUri: '/tmp/permits.ndjson', bbbPointerUri: null })).toBe(false);
  });

  it('is true as soon as one source is on S3', () => {
    expect(needsS3({ permitStatusUri: null, bbbPointerUri: 's3://bucket/current.json' })).toBe(
      true,
    );
  });
});

describe('contractorKey', () => {
  it('strips parentheticals, punctuation and a trailing corporate suffix', () => {
    const expression = contractorKey('name');
    expect(expression).toContain('upper(name)');
    expect(expression).toContain('INC|INCORPORATED|LLC');
  });
});

describe('permitsCte', () => {
  it('deduplicates on the permit number so one permit is not counted open twice', () => {
    const cte = permitsCte('s3://bucket/permits.ndjson');
    expect(cte).toContain('PARTITION BY appNo');
    expect(cte).toContain('closedDate IS NOT NULL');
  });

  it('exposes the stripped parcel key the published table joins on', () => {
    expect(permitsCte('s3://bucket/permits.ndjson')).toContain("replace(parcelId, '-', '')");
  });

  it('escapes the configured location rather than interpolating it raw', () => {
    expect(permitsCte("s3://bucket/it's.ndjson")).toContain("'s3://bucket/it''s.ndjson'");
  });
});
