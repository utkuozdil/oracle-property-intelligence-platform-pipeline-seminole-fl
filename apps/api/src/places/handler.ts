/**
 * Lambda entry point for the Overture places ingest.
 *
 * One invocation is one whole run. There is no sharding and no Distributed Map because the
 * work is a single DuckDB session against object storage — the extract is one scan of one
 * theme, and splitting it would mean several workers each re-reading the same Parquet
 * footers to produce partial counts that then have to be reassembled.
 *
 * This is a container-image Lambda rather than a zipped one, and that is not a preference.
 * `./duckdb.ts` drives the DuckDB *command-line binary* through `execFileSync`, so the
 * runtime has to contain that binary and its `httpfs` and `spatial` extensions. They are
 * baked into the image at build time; nothing is downloaded on the invocation path, so a
 * scheduled run does not depend on the extension repository being reachable.
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
import { PlacesIngestRequest, type PlacesRunSummary, type RoofingJoinSummary } from './model';
import { s3Objects } from './objects';
import { runPlaces } from './run';

/**
 * Counted as `Artifact`, matching the BBB tier's choice for the same reason: `METRIC_ITEMS`
 * has no business-location noun, and adding one means editing the shared metrics module and
 * the dashboard manifest that registers widgets off it, both owned outside this tier.
 */
const ITEM = METRIC_ITEMS.artifact;

function configuredMemoryMb(): number {
  return Number(process.env.AWS_LAMBDA_FUNCTION_MEMORY_SIZE ?? '512');
}

/** What the state machine and its execution history record. */
export interface PlacesLambdaResult {
  runId: string;
  release: string;
  destination: string;
  businessLocations: number;
  roofingPlaces: number;
  objectsWritten: number;
  bytesWritten: number;
  summary: PlacesRunSummary;
  join: RoofingJoinSummary;
}

async function baseHandler(event: unknown): Promise<PlacesLambdaResult> {
  const payload = (event ?? {}) as { runId?: unknown; request?: unknown };
  const request = PlacesIngestRequest.parse(payload.request ?? {});
  const executionId =
    typeof payload.runId === 'string' && payload.runId.length > 0 ? payload.runId : 'adhoc';

  const bucket = process.env.DATA_BUCKET;
  if (!bucket) throw new Error('DATA_BUCKET is not set');

  const objects = s3Objects(bucket);
  const startedAt = Date.now();

  try {
    const result = await runPlaces({
      request,
      /**
       * Peer output is read from the bucket, not from disk. In Lambda there are no peer
       * working directories, so a local reader here would find nothing and the join would
       * report a confident zero for both hops — which is exactly the failure the earlier
       * 0% BBB rate looked like and was not.
       */
      peers: objects,
      sink: objects,
      // `/tmp` persists between warm invocations, and a stale release's tree would be
      // re-uploaded by the mirror step as though this run had produced it.
      clean: true,
    });

    const bytesWritten = result.published.reduce((total, object) => total + object.bytes, 0);

    metrics.addMetric(processedMetric(ITEM), MetricUnit.Count, result.summary.clippedCount);
    logger.info('places ingest complete', {
      executionId,
      runId: result.summary.runId,
      release: result.summary.release,
      businessLocations: result.summary.clippedCount,
      roofingPlaces: result.join.roofingPlaces,
      permitMatchRate: result.join.permitMatchRate,
      defensibleMatchRate: result.join.defensibleMatchRate,
      bbbMatchRate: result.join.bbbMatchRate,
      permitContractorSource: result.join.denominators.permitContractorSource,
      bbbBusinessSource: result.join.denominators.bbbBusinessSource,
      contentFingerprint: result.summary.contentFingerprint,
      objectsWritten: result.published.length,
      bytesWritten,
      elapsedSeconds: result.summary.elapsedSeconds,
    });
    for (const warning of result.summary.warnings) {
      logger.warn('places ingest warning', { warning });
    }

    return {
      runId: result.summary.runId,
      release: result.summary.release,
      destination: result.destination,
      businessLocations: result.summary.clippedCount,
      roofingPlaces: result.join.roofingPlaces,
      objectsWritten: result.published.length,
      bytesWritten,
      summary: result.summary,
      join: result.join,
    };
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
