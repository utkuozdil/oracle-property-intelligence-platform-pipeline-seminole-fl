import { describe, expect, it } from 'vitest';
import { listedSources, sourceTableRows } from './run-summary-rows';

const CATEGORY_ORDER = ['property', 'permit'];

const cama = {
  id: 'scpa-cama',
  label: 'Seminole County Property Appraiser',
  category: 'property',
  status: 'ingested' as const,
  records: 181218,
  recordUnit: 'parcels',
  collectedAt: '2026-09-01T08:05:56.000Z',
  cadence: 'Updated every night',
  provenance: 'https://files.scpafl.org/data/cama/SeminoleCounty.zip',
};

const permits = {
  id: 'permit-census',
  label: 'County building permits',
  category: 'permit',
  status: 'ingested' as const,
  records: 522358,
  recordUnit: 'permits',
  collectedAt: '2026-09-01T21:37:40.000Z',
  cadence: 'Checked every day',
  provenance: 'https://example.test/permits',
};

describe('sourceTableRows', () => {
  it('replaces the county-file source with every refresh run, then the other sources', () => {
    const rows = sourceTableRows(
      [cama, permits],
      [
        {
          runId: 'skip-1',
          status: 'skipped',
          skipReason: 'unchanged-etag',
          finishedAt: '2026-09-02T06:00:18.000Z',
          parcelCount: null,
        },
        {
          runId: 'pub-1',
          status: 'completed',
          skipReason: null,
          finishedAt: '2026-09-01T14:15:11.000Z',
          parcelCount: 181218,
        },
      ],
      'pub-1',
      CATEGORY_ORDER,
    );

    expect(rows.map((row) => [row.sourceId, row.status, row.collectedAt, row.cadence])).toEqual([
      [
        'scpa-cama',
        'skipped',
        '2026-09-02T06:00:18.000Z',
        'County file unchanged (same ETag)',
      ],
      ['scpa-cama', 'ingested', '2026-09-01T14:15:11.000Z', 'Published snapshot'],
      ['permit-census', 'ingested', '2026-09-01T21:37:40.000Z', 'Checked every day'],
    ]);
    expect(rows[0]?.records).toBeNull();
    expect(rows[1]?.records).toBe(181218);
  });

  it('keeps a single county-file row when no refresh history exists', () => {
    const rows = sourceTableRows([cama], [], null, CATEGORY_ORDER);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.collectedAt).toBe('2026-09-01T08:05:56.000Z');
  });

  it('counts unique loaded sources, not extra refresh rows', () => {
    const sources = listedSources([cama, permits]);
    expect(sources).toHaveLength(2);
    expect(sources.filter((source) => source.status === 'ingested')).toHaveLength(2);
  });
});
