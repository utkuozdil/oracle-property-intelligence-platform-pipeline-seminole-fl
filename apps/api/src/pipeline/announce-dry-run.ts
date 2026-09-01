import { injectLambdaContext } from '@aws-lambda-powertools/logger/middleware';
import { MetricUnit } from '@aws-lambda-powertools/metrics';
import { logMetrics } from '@aws-lambda-powertools/metrics/middleware';
import { captureLambdaHandler } from '@aws-lambda-powertools/tracer/middleware';
import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import middy from '@middy/core';
import { SERVICE_NAME } from '@oracle-seminole/shared';
import { logger, metrics, tracer } from '../observability';

/**
 * Announces that a run staged data and deliberately did **not** publish it.
 *
 * This state exists because the alternative — a `Pass` that quietly ends the workflow —
 * produced two green executions over an empty `publish/` prefix. A skipped publish is a
 * legitimate outcome, but it is not the same outcome as a completed one, and the only
 * safe default is one that announces itself.
 *
 * So the dry-run path is louder than the publish path: it logs at WARN, emits its own
 * metric so a dashboard can show publishes and skips side by side, notifies the
 * operations topic, and returns `published: false` into the execution output where it is
 * visible from `describe-execution` without reading the history.
 *
 * Not a PagerDuty page: an opted-into dry run is expected, and paging on expected things
 * is how a rotation learns to ignore pages.
 */

const sns = tracer.captureAWSv3Client(new SNSClient({}));

const OPERATIONS_TOPIC_ARN = process.env.OPERATIONS_TOPIC_ARN ?? '';

export interface AnnounceDryRunInput {
  runId: string;
  reason: string;
  parcelCount: number;
  partitionCount: number;
}

export interface AnnounceDryRunOutput {
  runId: string;
  published: false;
  reason: string;
  parcelCount: number;
  partitionCount: number;
}

async function baseHandler(event: AnnounceDryRunInput): Promise<AnnounceDryRunOutput> {
  metrics.addMetric('SnapshotPublishSkipped', MetricUnit.Count, 1);

  logger.warn('Run completed WITHOUT publishing — staged output only', {
    runId: event.runId,
    reason: event.reason,
    parcelCount: event.parcelCount,
  });

  await sns.send(
    new PublishCommand({
      TopicArn: OPERATIONS_TOPIC_ARN,
      Subject: `[${SERVICE_NAME}] Run ${event.runId} staged but NOT published`,
      Message: [
        `Run ${event.runId} finished successfully but did not publish.`,
        `Reason: ${event.reason}`,
        '',
        `${event.parcelCount.toLocaleString()} parcels are in staged/parcels/ across`,
        `${event.partitionCount} partitions. Nothing was written to publish/.`,
        '',
        'Downstream consumers read publish/current.json and will still see the',
        'previous snapshot, or none at all if this is the first run.',
        '',
        'To publish, start an execution with input {"publish": true} — or omit the key,',
        'since publishing is the default for a completed run.',
      ].join('\n'),
    }),
  );

  return {
    runId: event.runId,
    published: false,
    reason: event.reason,
    parcelCount: event.parcelCount,
    partitionCount: event.partitionCount,
  };
}

export const handler = middy(baseHandler)
  .use(injectLambdaContext(logger))
  .use(captureLambdaHandler(tracer))
  .use(logMetrics(metrics));
