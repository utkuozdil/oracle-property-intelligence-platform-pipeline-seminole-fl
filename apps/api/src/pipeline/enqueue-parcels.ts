import { injectLambdaContext } from '@aws-lambda-powertools/logger/middleware';
import { logMetrics } from '@aws-lambda-powertools/metrics/middleware';
import { captureLambdaHandler } from '@aws-lambda-powertools/tracer/middleware';
import { SQSClient, SendMessageBatchCommand } from '@aws-sdk/client-sqs';
import middy from '@middy/core';
import { METRIC_ITEMS } from '@oracle-seminole/shared';
import { logger, metrics, recordWork, tracer } from '../observability';

const sqs = tracer.captureAWSv3Client(new SQSClient({}));

export interface EnqueueParcelsInput {
  runId: string;
  /** Parcel ids to dispatch. Phase 0 synthesises one placeholder id when omitted. */
  parcelIds?: string[];
}

export interface EnqueueParcelsOutput {
  runId: string;
  dispatched: number;
}

/**
 * Phase 0 stub for the fan-out task in `PermitHarvest`. It pushes parcel ids onto the
 * permit-harvest queue so the queue, its consumer, its dead-letter queue, and the
 * alarm on that queue are all exercised by a single state-machine execution.
 */
async function baseHandler(event: EnqueueParcelsInput): Promise<EnqueueParcelsOutput> {
  return recordWork(METRIC_ITEMS.parcel, async () => {
    const queueUrl = process.env.PERMIT_QUEUE_URL;
    if (!queueUrl) {
      throw new Error('PERMIT_QUEUE_URL is not configured');
    }

    const parcelIds = event.parcelIds ?? [`stub-parcel-${event.runId}`];

    await sqs.send(
      new SendMessageBatchCommand({
        QueueUrl: queueUrl,
        Entries: parcelIds.map((parcelId, index) => ({
          Id: String(index),
          MessageBody: JSON.stringify({ runId: event.runId, parcelId }),
        })),
      }),
    );

    logger.info('Dispatched parcels for permit harvest', {
      runId: event.runId,
      dispatched: parcelIds.length,
    });

    return { runId: event.runId, dispatched: parcelIds.length };
  });
}

export const handler = middy(baseHandler)
  .use(injectLambdaContext(logger))
  .use(captureLambdaHandler(tracer))
  .use(logMetrics(metrics));
