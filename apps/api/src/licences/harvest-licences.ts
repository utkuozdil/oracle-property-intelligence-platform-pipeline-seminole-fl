/**
 * Lambda entry point for the DBPR licence harvest.
 *
 * One invocation is one whole run: two HTTP requests, one parse pass over 48.8 MB, one join,
 * and the writes. There is no Distributed Map and no sharding because there is nothing to
 * shard — the source is a single object with no server-side filter, served at about
 * 188 KB/s, and the wall clock is set by that transfer rather than by any work this code does.
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
import { LicenceHarvestRequest, type LicenceRunSummary } from './model';

/**
 * Counted as `Artifact` rather than a noun of its own.
 *
 * `METRIC_ITEMS` has no contractor/licence noun, and adding one means editing
 * `packages/shared/src/metrics.ts` *and* the `observability/metrics.json` staging manifest that
 * registers dashboard widgets — both owned outside this tier. The BBB tier made the same
 * choice for the same reason; a shared `ContractorSignal` item is the right follow-up for both.
 */
const ITEM = METRIC_ITEMS.artifact;

function configuredMemoryMb(): number {
  return Number(process.env.AWS_LAMBDA_FUNCTION_MEMORY_SIZE ?? '512');
}

async function baseHandler(event: unknown): Promise<LicenceRunSummary> {
  const payload = (event ?? {}) as { runId?: unknown; request?: unknown };
  const runId =
    typeof payload.runId === 'string' && payload.runId.length > 0
      ? payload.runId
      : new Date().toISOString().replace(/[:.]/g, '-');
  const request = LicenceHarvestRequest.parse(payload.request ?? {});

  const startedAt = Date.now();
  try {
    const { summary } = await harvest({
      ...request,
      runId,
      onProgress: (message, detail) => logger.debug(message, detail ?? {}),
    });

    // Volume, not invocations: one run lands thousands of licences and the count is the signal.
    metrics.addMetric(processedMetric(ITEM), MetricUnit.Count, summary.seminoleLicences);
    logger.info('Licence harvest complete', {
      runId: summary.runId,
      seminoleLicences: summary.seminoleLicences,
      adverseLicences: summary.adverseLicences,
      contractorsConsidered: summary.contractorsConsidered,
      contractorsMatched: summary.contractorsMatched,
      contractorsMatchedByKey: summary.contractorsMatchedByKey,
      matchRate: summary.matchRate,
      keyedMatchRate: summary.keyedMatchRate,
      contractorsWithAdverseLicence: summary.contractorsWithAdverseLicence,
      servedFromLedger: summary.servedFromLedger,
      sourceLastModified: summary.sourceLastModified,
      downloadSeconds: summary.downloadSeconds,
    });
    if (summary.warnings.length > 0) {
      logger.warn('Licence harvest completed with warnings', { warnings: summary.warnings });
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
