import { describe, expect, it } from 'vitest';
import { METRIC_ITEMS, failedMetric, predictInvocationCostUsd, processedMetric } from './metrics';

describe('metric names', () => {
  it('derives PascalCase {Item}Processed / {Item}Failed names', () => {
    expect(processedMetric(METRIC_ITEMS.parcel)).toBe('ParcelProcessed');
    expect(failedMetric(METRIC_ITEMS.parcel)).toBe('ParcelFailed');
    expect(processedMetric(METRIC_ITEMS.permit)).toBe('PermitProcessed');
    expect(failedMetric(METRIC_ITEMS.artifact)).toBe('ArtifactFailed');
  });
});

describe('predictInvocationCostUsd', () => {
  it('charges the per-request floor even for a zero-duration invocation', () => {
    expect(predictInvocationCostUsd(0, 512)).toBeCloseTo(0.0000002, 12);
  });

  it('scales with both memory and duration', () => {
    expect(predictInvocationCostUsd(200, 1024)).toBeGreaterThan(predictInvocationCostUsd(100, 512));
  });
});
