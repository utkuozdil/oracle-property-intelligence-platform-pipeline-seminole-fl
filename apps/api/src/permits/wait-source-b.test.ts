import { describe, expect, it, vi } from 'vitest';
import { TransientRequestError, WafBlockedError } from './http';
import type { StatusBatch, StatusBatchResult } from './model';
import { PermitDetailUnavailableError, PermitSourceUnavailableError } from './source-b';
import {
  harvestStatusBatchWhenReady,
  isRetryableSourceBFailure,
  sourceBUnavailableRetryMs,
} from './wait-source-b';

const BATCH = {
  runId: 'test',
  batchKey: 's3://example/batch-0000.ndjson',
  batchIndex: 0,
  permitCount: 1,
} as StatusBatch;

const OK: StatusBatchResult = {
  runId: 'test',
  batchIndex: 0,
  permitsRequested: 1,
  permitsHarvested: 1,
  permitsSkippedTerminal: 0,
  openPermits: 0,
  closedPermits: 1,
  withCloseDate: 1,
  quarantined: [],
  recordsKey: null,
  latencyMs: { min: 1, median: 1, max: 1 },
  warnings: [],
};

describe('source-B outage retry', () => {
  it('defaults to 20 minutes and accepts an env override', () => {
    expect(sourceBUnavailableRetryMs({})).toBe(20 * 60 * 1000);
    expect(sourceBUnavailableRetryMs({ SOURCE_B_UNAVAILABLE_RETRY_MS: '500' })).toBe(500);
    expect(sourceBUnavailableRetryMs({ SOURCE_B_UNAVAILABLE_RETRY_MS: 'nope' })).toBe(
      20 * 60 * 1000,
    );
  });

  it('retries a portal error page after the wait, without treating WAF as retryable', () => {
    expect(isRetryableSourceBFailure(new PermitSourceUnavailableError('down'))).toBe(true);
    expect(isRetryableSourceBFailure(new TransientRequestError('timeout'))).toBe(true);
    expect(
      isRetryableSourceBFailure(new PermitDetailUnavailableError('one permit')),
    ).toBe(false);
    expect(
      isRetryableSourceBFailure(new WafBlockedError('https://example.test', 403, 'Support ID')),
    ).toBe(false);
  });

  it('sleeps then harvests the same batch once the probe succeeds', async () => {
    const sleeps: number[] = [];
    const logs: string[] = [];
    let probes = 0;
    const harvest = vi.fn(async () => OK);

    const result = await harvestStatusBatchWhenReady(BATCH, {
      retryMs: 20,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      log: (line) => logs.push(line),
      probe: async () => {
        probes += 1;
        if (probes === 1) throw new PermitSourceUnavailableError('Citizen Engagement Portal - Error!');
      },
      harvest,
    });

    expect(result).toEqual(OK);
    expect(sleeps).toEqual([20]);
    expect(harvest).toHaveBeenCalledTimes(1);
    expect(harvest).toHaveBeenCalledWith(BATCH);
    expect(logs[0]).toMatch(/wait 0s then retry batch 0 \(attempt 1\)/);
  });

  it('does not wait on a WAF block', async () => {
    const sleep = vi.fn(async () => undefined);
    await expect(
      harvestStatusBatchWhenReady(BATCH, {
        retryMs: 20,
        sleep,
        probe: async () => {
          throw new WafBlockedError('https://example.test', 403, 'Support ID');
        },
        harvest: async () => OK,
      }),
    ).rejects.toThrow(WafBlockedError);
    expect(sleep).not.toHaveBeenCalled();
  });
});
