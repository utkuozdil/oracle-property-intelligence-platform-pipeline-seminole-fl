import { injectLambdaContext } from '@aws-lambda-powertools/logger/middleware';
import { logMetrics } from '@aws-lambda-powertools/metrics/middleware';
import { captureLambdaHandler } from '@aws-lambda-powertools/tracer/middleware';
import middy from '@middy/core';
import { COUNTY, METRIC_ITEMS } from '@oracle-seminole/shared';
import { logger, metrics, recordWork, tracer } from '../observability';

export interface RecordRunInput {
  runId: string;
  /** Sources the run intends to read. Empty in Phase 0. */
  sources?: string[];
}

export interface RecordRunOutput {
  runId: string;
  county: string;
  sources: string[];
  stage: 'stub';
  recordedAt: string;
}

/**
 * Phase 0 stub for the run-bookkeeping task in `SeminoleRefresh`.
 *
 * It proves the state machine can invoke a Powertools-instrumented Lambda and that the
 * run metrics reach CloudWatch. It deliberately reads and writes nothing.
 */
async function baseHandler(event: RecordRunInput): Promise<RecordRunOutput> {
  return recordWork(METRIC_ITEMS.run, async () => {
    logger.info('Recording ingestion run', { runId: event.runId, county: COUNTY });
    return {
      runId: event.runId,
      county: COUNTY,
      sources: event.sources ?? [],
      stage: 'stub' as const,
      recordedAt: new Date().toISOString(),
    };
  });
}

export const handler = middy(baseHandler)
  .use(injectLambdaContext(logger))
  .use(captureLambdaHandler(tracer))
  .use(logMetrics(metrics));
