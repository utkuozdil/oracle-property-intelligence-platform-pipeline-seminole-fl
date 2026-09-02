import { describe, expect, it } from 'vitest';
import {
  latestStatusCompletion,
  latestTimestamp,
  permitStatusSourceState,
} from './permit-status-source';

describe('permitStatusSourceState', () => {
  it('stays not-ingested until a batch or a completion exists', () => {
    expect(
      permitStatusSourceState({
        statusBatchCount: null,
        latestStatusBatchAt: null,
        lastCompletedAt: null,
        lastCompletedRecords: null,
      }),
    ).toEqual({
      status: 'not-ingested',
      collectedAt: null,
      records: null,
      cadence: 'Still being collected',
    });
  });

  it('hides Collected while a newer sweep is still running, but keeps the harvested count', () => {
    expect(
      permitStatusSourceState({
        statusBatchCount: 62,
        latestStatusBatchAt: '2026-09-02T04:07:41.000Z',
        lastCompletedAt: '2026-09-01T15:39:17.000Z',
        lastCompletedRecords: 150,
        harvestedRecords: 7350,
      }),
    ).toEqual({
      status: 'in-progress',
      collectedAt: null,
      records: 7350,
      cadence: 'Still being collected',
    });
  });

  it('shows — while the first sweep is still running', () => {
    expect(
      permitStatusSourceState({
        statusBatchCount: 10,
        latestStatusBatchAt: '2026-09-02T04:07:41.000Z',
        lastCompletedAt: null,
        lastCompletedRecords: null,
      }).collectedAt,
    ).toBeNull();
  });

  it('updates Collected only after a sweep writes a completion at or after the last batch', () => {
    expect(
      permitStatusSourceState({
        statusBatchCount: 274,
        latestStatusBatchAt: '2026-09-02T11:00:00.000Z',
        lastCompletedAt: '2026-09-02T11:00:05.000Z',
        lastCompletedRecords: 41026,
      }),
    ).toEqual({
      status: 'ingested',
      collectedAt: '2026-09-02T11:00:05.000Z',
      records: 41026,
      cadence: 'Updated when a sweep finishes',
    });
  });
});

describe('latestStatusCompletion', () => {
  it('prefers finishedAt over LastModified and keeps the newest', () => {
    expect(
      latestStatusCompletion([
        { lastModified: '2026-09-01T15:39:17.000Z', permitsLanded: 30 },
        {
          lastModified: '2026-09-02T11:00:06.000Z',
          finishedAt: '2026-09-02T11:00:05.000Z',
          permitsLanded: 41026,
        },
      ]),
    ).toEqual({ completedAt: '2026-09-02T11:00:05.000Z', records: 41026 });
  });
});

describe('latestTimestamp', () => {
  it('returns the max ISO timestamp', () => {
    expect(latestTimestamp([null, '2026-09-02T04:07:41.000Z', '2026-09-01T15:00:00.000Z'])).toBe(
      '2026-09-02T04:07:41.000Z',
    );
  });
});
