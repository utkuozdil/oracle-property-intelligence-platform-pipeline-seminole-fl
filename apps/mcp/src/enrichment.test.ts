import { describe, expect, it } from 'vitest';
import {
  describeEnrichment,
  needsS3,
  normaliseParcelId,
  openRoofingCte,
  uriLooksLikeParquet,
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
    const status = describeEnrichment({ permitPointerUri: null });
    expect(status.permits.available).toBe(false);
    expect(status.bbb.available).toBe(false);
    expect(status.permits.reason).toContain('not answered as zero');
  });

  it('still qualifies the answer when the published snapshot is configured', () => {
    const status = describeEnrichment({
      permitPointerUri: 's3://bucket/publish/permits/current.json',
    });
    expect(status.permits.available).toBe(true);
    expect(status.permits.reason).toContain('unknown');
    expect(status.bbb.available).toBe(true);
  });
});

describe('needsS3', () => {
  it('is false when nothing is configured, so no AWS extension is loaded', () => {
    expect(needsS3({ permitPointerUri: null })).toBe(false);
  });

  it('is false for local files', () => {
    expect(needsS3({ permitPointerUri: '/tmp/permits.parquet' })).toBe(false);
  });

  it('is true as soon as the pointer is on S3', () => {
    expect(needsS3({ permitPointerUri: 's3://bucket/publish/permits/current.json' })).toBe(true);
  });
});

describe('openRoofingCte', () => {
  it('counts only confirmed-open roofing rows', () => {
    const cte = openRoofingCte('s3://bucket/permits.parquet');
    expect(cte).toContain("status = 'open'");
    expect(cte).not.toContain('NOT terminal');
  });

  it('exposes the stripped parcel key the published table joins on', () => {
    expect(openRoofingCte('s3://bucket/permits.parquet')).toContain("replace(parcel_id, '-', '')");
  });

  it('escapes the configured location rather than interpolating it raw', () => {
    expect(openRoofingCte("s3://bucket/it's.parquet")).toContain("'s3://bucket/it''s.parquet'");
  });
});

describe('uriLooksLikeParquet', () => {
  it('treats a direct parquet path as ready to read', () => {
    expect(uriLooksLikeParquet('s3://bucket/permits.parquet')).toBe(true);
    expect(uriLooksLikeParquet('s3://bucket/publish/permits/current.json')).toBe(false);
  });
});
