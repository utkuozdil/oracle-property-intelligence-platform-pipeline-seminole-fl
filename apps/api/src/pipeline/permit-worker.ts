import { injectLambdaContext } from '@aws-lambda-powertools/logger/middleware';
import { logMetrics } from '@aws-lambda-powertools/metrics/middleware';
import { captureLambdaHandler } from '@aws-lambda-powertools/tracer/middleware';
import middy from '@middy/core';
import { METRIC_ITEMS } from '@oracle-seminole/shared';
import type { SQSBatchResponse, SQSEvent } from 'aws-lambda';
import { logger, metrics, recordWork, tracer } from '../observability';

/**
 * Phase 0 stub consumer of the permit-harvest queue.
 *
 * Failures are reported per message via partial batch responses, so a single bad
 * message is retried and eventually redriven to the dead-letter queue instead of
 * poisoning the whole batch. The DLQ alarm is the only alert this path raises.
 */
async function baseHandler(event: SQSEvent): Promise<SQSBatchResponse> {
  const batchItemFailures: SQSBatchResponse['batchItemFailures'] = [];

  for (const record of event.Records) {
    try {
      await recordWork(METRIC_ITEMS.permit, async () => {
        const payload: unknown = JSON.parse(record.body);
        logger.info('Harvesting permits for parcel', { payload });
      });
    } catch (error) {
      logger.error('Permit harvest failed for message', { messageId: record.messageId, error });
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures };
}

export const handler = middy(baseHandler)
  .use(injectLambdaContext(logger))
  .use(captureLambdaHandler(tracer))
  .use(logMetrics(metrics));
