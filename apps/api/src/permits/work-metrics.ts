/**
 * Per-worker-unit metrics for the permit tier.
 *
 * `recordWork` in `src/observability.ts` counts one processed item per invocation, which is
 * right for a request handler and wrong for a harvest shard that lands hundreds of permits
 * in one invocation. This emits the same four metrics with the real volume, so progress and
 * failures are visible per shard while a multi-hour sweep is still running rather than only
 * in a summary at the end.
 */
import { MetricUnit } from '@aws-lambda-powertools/metrics';
import {
  UNIVERSAL_METRICS,
  failedMetric,
  predictInvocationCostUsd,
  processedMetric,
  type MetricItem,
} from '@oracle-seminole/shared';
import { metrics } from '../observability';

function configuredMemoryMb(): number {
  return Number(process.env.AWS_LAMBDA_FUNCTION_MEMORY_SIZE ?? '512');
}

/**
 * Wraps a shard of work, taking the processed count from the work's own result so the
 * `{Item}Processed` metric reports permits and not invocations.
 */
export async function recordVolume<T>(
  item: MetricItem,
  work: () => Promise<T>,
  countOf: (result: T) => number,
): Promise<T> {
  const startedAt = Date.now();
  try {
    const result = await work();
    metrics.addMetric(processedMetric(item), MetricUnit.Count, countOf(result));
    return result;
  } catch (error) {
    metrics.addMetric(failedMetric(item), MetricUnit.Count, 1);
    throw error;
  } finally {
    const durationMs = Date.now() - startedAt;
    metrics.addMetric(UNIVERSAL_METRICS.processingDuration, MetricUnit.Milliseconds, durationMs);
    metrics.addMetric(
      UNIVERSAL_METRICS.costPredicted,
      MetricUnit.NoUnit,
      predictInvocationCostUsd(durationMs, configuredMemoryMb()),
    );
  }
}
