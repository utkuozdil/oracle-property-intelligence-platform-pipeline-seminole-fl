import { describe, expect, it } from 'vitest';
import {
  ARCHIVE_BYTES_MAX,
  ARCHIVE_BYTES_MIN,
  COST_CEILING_USD,
  GLUE_MINUTES_PER_UNCOMPRESSED_GB,
  OBSERVED_ARCHIVE_BYTES,
  OBSERVED_GLUE_MINUTES_PER_GB,
  predictTransformCostUsd,
  SOURCE_USER_AGENT,
} from './source';

describe('the transform cost model', () => {
  it('predicts an ordinary night below the ceiling', () => {
    const estimate = predictTransformCostUsd(OBSERVED_ARCHIVE_BYTES);
    expect(estimate.totalCostUsd).toBeLessThan(COST_CEILING_USD);
    // A model that predicts near-zero would make the gate decorative.
    expect(estimate.totalCostUsd).toBeGreaterThan(0.1);
  });

  it('trips the ceiling on an archive several times its normal size', () => {
    const estimate = predictTransformCostUsd(OBSERVED_ARCHIVE_BYTES * 5);
    expect(estimate.totalCostUsd).toBeGreaterThan(COST_CEILING_USD);
  });

  it('scales with input volume rather than returning a constant', () => {
    const single = predictTransformCostUsd(OBSERVED_ARCHIVE_BYTES);
    const double = predictTransformCostUsd(OBSERVED_ARCHIVE_BYTES * 2);
    expect(double.estimatedDpuHours).toBeCloseTo(single.estimatedDpuHours * 2, 3);
  });

  it('stays above the measured rate so the gate errs early, not late', () => {
    // The whole point of the gate is to refuse surprises. A model calibrated below
    // reality would let a genuinely expensive run through unchallenged.
    expect(GLUE_MINUTES_PER_UNCOMPRESSED_GB).toBeGreaterThan(OBSERVED_GLUE_MINUTES_PER_GB);
  });

  it('does not over-predict so far that the estimate stops meaning anything', () => {
    // The pre-run guess was 5.4x the measured rate, which made every prediction noise.
    expect(GLUE_MINUTES_PER_UNCOMPRESSED_GB).toBeLessThan(OBSERVED_GLUE_MINUTES_PER_GB * 3);
  });

  it('never predicts below the one-minute Glue billing floor', () => {
    const estimate = predictTransformCostUsd(1_024);
    expect(estimate.estimatedGlueMinutes).toBeGreaterThanOrEqual(1);
  });
});

describe('the source volume band', () => {
  it('accepts the observed archive and rejects an order-of-magnitude change', () => {
    expect(OBSERVED_ARCHIVE_BYTES).toBeGreaterThan(ARCHIVE_BYTES_MIN);
    expect(OBSERVED_ARCHIVE_BYTES).toBeLessThan(ARCHIVE_BYTES_MAX);
    expect(OBSERVED_ARCHIVE_BYTES * 10).toBeGreaterThan(ARCHIVE_BYTES_MAX);
    // A near-empty file is the classic source-side failure and must not pass.
    expect(1_024).toBeLessThan(ARCHIVE_BYTES_MIN);
  });
});

describe('the source user agent', () => {
  it('looks like a browser, because the host stalls the socket otherwise', () => {
    expect(SOURCE_USER_AGENT).toMatch(/^Mozilla\/5\.0 /);
    expect(SOURCE_USER_AGENT).toContain('Chrome/');
  });
});
