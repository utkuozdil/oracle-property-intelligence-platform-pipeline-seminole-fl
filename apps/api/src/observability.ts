import { Logger } from '@aws-lambda-powertools/logger';
import { Metrics, MetricUnit } from '@aws-lambda-powertools/metrics';
import { Tracer } from '@aws-lambda-powertools/tracer';
import {
  METRICS_NAMESPACE,
  SERVICE_NAME,
  UNIVERSAL_METRICS,
  failedMetric,
  parseTargetEnv,
  predictInvocationCostUsd,
  processedMetric,
  type MetricItem,
} from '@oracle-seminole/shared';

const serviceName = process.env.POWERTOOLS_SERVICE_NAME ?? SERVICE_NAME;
const namespace = process.env.POWERTOOLS_METRICS_NAMESPACE ?? METRICS_NAMESPACE;
const environment = parseTargetEnv(process.env.TARGET_ENV);

export const logger = new Logger({ serviceName });
export const tracer = new Tracer({ serviceName });

/**
 * `service` is declared explicitly because {@link Metrics.setDefaultDimensions}-style
 * defaults replace Powertools' built-in dimension set rather than merging with it.
 * Every metric this service emits therefore carries `service` and `environment`.
 */
export const metrics = new Metrics({
  serviceName,
  namespace,
  defaultDimensions: { service: serviceName, environment },
});

function configuredMemoryMb(): number {
  return Number(process.env.AWS_LAMBDA_FUNCTION_MEMORY_SIZE ?? '512');
}

/**
 * Wraps a unit of work in the four metrics every service owes: `{Item}Processed`,
 * `{Item}Failed`, `ProcessingDuration`, and `CostPredicted`.
 *
 * Metrics are only buffered here — the `logMetrics` middleware flushes them once
 * per invocation, so a single EMF record carries the whole set.
 */
export async function recordWork<T>(item: MetricItem, work: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  try {
    const result = await work();
    metrics.addMetric(processedMetric(item), MetricUnit.Count, 1);
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
