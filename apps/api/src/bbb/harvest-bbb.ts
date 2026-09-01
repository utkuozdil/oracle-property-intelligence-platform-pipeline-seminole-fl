/**
 * Lambda entry point for the BBB harvest.
 *
 * One invocation is one whole run: seven seed searches plus one lookup per contractor, all
 * sequential at ~1 req/s. There is no Distributed Map and no sharding, because the work is
 * hundreds of requests rather than tens of thousands and the politeness ceiling — not
 * parallelism — is what sets the wall clock. Splitting it across workers would multiply the
 * request rate at the source while saving nothing that matters.
 */
import { injectLambdaContext } from '@aws-lambda-powertools/logger/middleware';
import { MetricUnit } from '@aws-lambda-powertools/metrics';
import { logMetrics } from '@aws-lambda-powertools/metrics/middleware';
import { captureLambdaHandler } from '@aws-lambda-powertools/tracer/middleware';
import middy from '@middy/core';
import {
  METRIC_ITEMS,
  UNIVERSAL_METRICS,
  failedMetric,
  predictInvocationCostUsd,
  processedMetric,
} from '@oracle-seminole/shared';
import { logger, metrics, tracer } from '../observability';
import { harvest } from './harvest';
import { BbbHarvestRequest, type BbbRunSummary } from './model';

/**
 * Counted as `Artifact` rather than a noun of its own.
 *
 * `METRIC_ITEMS` has no contractor/reputation noun, and adding one means editing
 * `packages/shared/src/metrics.ts` *and* the `observability/metrics.json` staging manifest
 * that registers dashboard widgets — both owned outside this tier. `Artifact` is the closest
 * existing noun; a dedicated `ContractorRating` item is the right follow-up.
 */
const ITEM = METRIC_ITEMS.artifact;

function configuredMemoryMb(): number {
  return Number(process.env.AWS_LAMBDA_FUNCTION_MEMORY_SIZE ?? '512');
}

async function baseHandler(event: unknown): Promise<BbbRunSummary> {
  const payload = (event ?? {}) as { runId?: unknown; request?: unknown };
  const runId =
    typeof payload.runId === 'string' && payload.runId.length > 0
      ? payload.runId
      : new Date().toISOString().replace(/[:.]/g, '-');
  const request = BbbHarvestRequest.parse(payload.request ?? {});

  const startedAt = Date.now();
  try {
    const { summary } = await harvest({
      ...request,
      runId,
      onProgress: (message, detail) => logger.debug(message, detail ?? {}),
    });

    // Volume, not invocations: one run lands hundreds of records and the count is the signal.
    metrics.addMetric(processedMetric(ITEM), MetricUnit.Count, summary.businessesDistinct);
    logger.info('BBB harvest complete', {
      ...summary,
      // Useful in the artifact, noise in a log line.
      ratingDistribution: Object.keys(summary.ratingDistribution).length,
    });
    if (summary.warnings.length > 0) {
      logger.warn('BBB harvest completed with warnings', { warnings: summary.warnings });
    }
    return summary;
  } catch (error) {
    metrics.addMetric(failedMetric(ITEM), MetricUnit.Count, 1);
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

export const handler = middy(baseHandler)
  .use(injectLambdaContext(logger))
  .use(captureLambdaHandler(tracer))
  .use(logMetrics(metrics));
