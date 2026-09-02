import { describe, expect, it } from 'vitest';
import { skippedRunManifest } from './record-run';

describe('skipped run bookkeeping', () => {
  it('writes a manifest the run summary can list, not a silent success', () => {
    expect(
      skippedRunManifest(
        {
          runId: 'nightly-skip',
          skipped: true,
          skipReason: 'unchanged-etag',
          sourceEtag: '"951370b7e839dd1:0"',
          sourceLastModified: 'Tue, 01 Sep 2026 08:05:56 GMT',
          startedAt: '2026-09-02T06:00:15.145Z',
        },
        '2026-09-02T06:00:18.916Z',
      ),
    ).toEqual({
      runId: 'nightly-skip',
      county: 'Seminole County, FL',
      phase: 'phase-1',
      status: 'SKIPPED',
      skipReason: 'unchanged-etag',
      startedAt: '2026-09-02T06:00:15.145Z',
      finishedAt: '2026-09-02T06:00:18.916Z',
      sources: ['scpa-cama'],
      sourceEtag: '"951370b7e839dd1:0"',
      sourceLastModified: 'Tue, 01 Sep 2026 08:05:56 GMT',
      publishDecision: 'no new snapshot (unchanged-etag)',
    });
  });
});
