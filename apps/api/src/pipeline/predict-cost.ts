import { injectLambdaContext } from '@aws-lambda-powertools/logger/middleware';
import { MetricUnit } from '@aws-lambda-powertools/metrics';
import { logMetrics } from '@aws-lambda-powertools/metrics/middleware';
import { captureLambdaHandler } from '@aws-lambda-powertools/tracer/middleware';
import middy from '@middy/core';
import {
  ARCHIVE_BYTES_MAX,
  ARCHIVE_BYTES_MIN,
  COST_CEILING_USD,
  predictTransformCostUsd,
  SOURCE_URL,
  SOURCE_USER_AGENT,
  UNIVERSAL_METRICS,
} from '@oracle-seminole/shared';
import { z } from 'zod';
import { logger, metrics, tracer } from '../observability';

/**
 * Step one of `SeminoleRefresh`: cost prediction, before any data is touched.
 *
 * Volume comes from a `HEAD` against the source. That `HEAD` is the only place the
 * archive's size, ETag, and `Last-Modified` are read, and all three are handed
 * downstream — so the whole workflow makes exactly one metadata request and one
 * download against a single county web server per run.
 *
 * The `HEAD` is a control-plane read of one object's headers, not a processing workload,
 * so it does not itself need a strategy or a gate.
 */

export interface PredictCostInput {
  runId: string;
  /** Overrides the built-in ceiling. Present so a manual run can be deliberately capped lower. */
  costCeilingUsd?: number;
}

export interface PredictCostOutput {
  runId: string;
  status: 'APPROVED' | 'APPROVAL_REQUIRED';
  estimatedCostUsd: number;
  ceilingUsd: number;
  source: {
    url: string;
    etag: string | null;
    lastModified: string | null;
    contentLength: number;
  };
  estimate: {
    estimatedGlueMinutes: number;
    estimatedDpuHours: number;
    estimatedUncompressedBytes: number;
  };
  message: string;
}

/**
 * Headers the source must return for the workflow to proceed.
 *
 * `content-length` is required because it is the cost model's only input; a source that
 * stops sending it cannot be costed, and an uncosted run must not start. Validated with
 * Zod rather than read positionally so a changed header contract fails here with a
 * readable error instead of producing `NaN` dollars.
 */
const SourceHeaders = z.object({
  'content-length': z.coerce.number().int().positive(),
  etag: z.string().min(1).nullable(),
  'last-modified': z.string().min(1).nullable(),
});

class SourceUnavailableError extends Error {
  override readonly name = 'SourceUnavailableError';
}

class SourceVolumeError extends Error {
  override readonly name = 'SourceVolumeError';
}

async function headSource(): Promise<z.infer<typeof SourceHeaders>> {
  const response = await fetch(SOURCE_URL, {
    method: 'HEAD',
    // Load-bearing: without a browser-like agent the host stalls the socket instead of
    // returning a status, so the Lambda would burn its full timeout for no signal.
    headers: { 'User-Agent': SOURCE_USER_AGENT, Accept: '*/*' },
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    throw new SourceUnavailableError(
      `HEAD ${SOURCE_URL} returned ${response.status} ${response.statusText}`,
    );
  }

  const parsed = SourceHeaders.safeParse({
    'content-length': response.headers.get('content-length'),
    etag: response.headers.get('etag'),
    'last-modified': response.headers.get('last-modified'),
  });

  if (!parsed.success) {
    throw new SourceUnavailableError(
      `HEAD ${SOURCE_URL} returned unusable headers: ${parsed.error.message}`,
    );
  }

  return parsed.data;
}

async function baseHandler(event: PredictCostInput): Promise<PredictCostOutput> {
  const ceiling = event.costCeilingUsd ?? COST_CEILING_USD;
  const headers = await headSource();
  const contentLength = headers['content-length'];

  // A wildly different archive size is the cheapest early warning that the source
  // changed shape. Refusing here costs nothing; discovering it after 10 DPU-minutes does.
  if (contentLength < ARCHIVE_BYTES_MIN || contentLength > ARCHIVE_BYTES_MAX) {
    throw new SourceVolumeError(
      `archive is ${contentLength} bytes, outside the expected ` +
        `${ARCHIVE_BYTES_MIN}-${ARCHIVE_BYTES_MAX} band — inspect the source before ingesting`,
    );
  }

  const estimate = predictTransformCostUsd(contentLength);
  const overBudget = estimate.totalCostUsd > ceiling;

  // `CostPredicted` carries the `service` dimension, whose value equals the CDK
  // `project_name` tag, so predicted spend joins against billed spend on one key.
  metrics.addMetric(UNIVERSAL_METRICS.costPredicted, MetricUnit.NoUnit, estimate.totalCostUsd);

  logger.info('Predicted transform cost', {
    runId: event.runId,
    contentLength,
    etag: headers.etag,
    estimatedCostUsd: estimate.totalCostUsd,
    ceilingUsd: ceiling,
    overBudget,
  });

  return {
    runId: event.runId,
    status: overBudget ? 'APPROVAL_REQUIRED' : 'APPROVED',
    estimatedCostUsd: Number(estimate.totalCostUsd.toFixed(4)),
    ceilingUsd: ceiling,
    source: {
      url: SOURCE_URL,
      etag: headers.etag,
      lastModified: headers['last-modified'],
      contentLength,
    },
    estimate: {
      estimatedGlueMinutes: Number(estimate.estimatedGlueMinutes.toFixed(1)),
      estimatedDpuHours: Number(estimate.estimatedDpuHours.toFixed(3)),
      estimatedUncompressedBytes: Math.round(estimate.estimatedUncompressedBytes),
    },
    message: overBudget
      ? `Estimated $${estimate.totalCostUsd.toFixed(2)} exceeds the $${ceiling.toFixed(2)} ceiling. Manual approval required.`
      : `Estimated $${estimate.totalCostUsd.toFixed(2)}, within the $${ceiling.toFixed(2)} ceiling.`,
  };
}

export const handler = middy(baseHandler)
  .use(injectLambdaContext(logger))
  .use(captureLambdaHandler(tracer))
  .use(logMetrics(metrics));
