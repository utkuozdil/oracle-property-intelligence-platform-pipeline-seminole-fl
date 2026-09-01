import { injectLambdaContext } from '@aws-lambda-powertools/logger/middleware';
import { logMetrics } from '@aws-lambda-powertools/metrics/middleware';
import { captureLambdaHandler } from '@aws-lambda-powertools/tracer/middleware';
import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import middy from '@middy/core';
import { SERVICE_NAME } from '@oracle-seminole/shared';
import { logger, metrics, tracer } from '../observability';

/**
 * The cost gate's pause. Invoked with `WAIT_FOR_TASK_TOKEN`, so it returns immediately
 * and the execution sits in `Running` until a human resolves the token.
 *
 * It only announces the decision it needs; it does not make it. Approval is
 * `aws stepfunctions send-task-success`, rejection is `send-task-failure`, and the
 * command lines for both go into the notification so whoever is paged does not have to
 * reconstruct them.
 *
 * This is deliberately **not** a PagerDuty page. A cost-gate pause is an expected
 * human-in-the-loop wait, and paging on-call for an expected wait is how a rotation
 * learns to ignore its pages.
 */

const sns = tracer.captureAWSv3Client(new SNSClient({}));

const OPERATIONS_TOPIC_ARN = process.env.OPERATIONS_TOPIC_ARN ?? '';

export interface AwaitApprovalInput {
  taskToken: string;
  runId: string;
  estimatedCostUsd: number;
  ceilingUsd: number;
  executionArn: string;
}

async function baseHandler(event: AwaitApprovalInput): Promise<void> {
  const approve = `aws stepfunctions send-task-success --region us-east-2 --task-token '${event.taskToken}' --task-output '{"approved":true}'`;
  const reject = `aws stepfunctions send-task-failure --region us-east-2 --task-token '${event.taskToken}' --error CostRejected --cause 'Rejected by operator'`;

  await sns.send(
    new PublishCommand({
      TopicArn: OPERATIONS_TOPIC_ARN,
      Subject: `[${SERVICE_NAME}] Cost approval needed: $${event.estimatedCostUsd.toFixed(2)}`,
      Message: [
        `Run ${event.runId} predicts $${event.estimatedCostUsd.toFixed(2)},`,
        `above the $${event.ceilingUsd.toFixed(2)} ceiling. The execution is paused.`,
        '',
        `Execution: ${event.executionArn}`,
        '',
        'Approve:',
        approve,
        '',
        'Reject:',
        reject,
      ].join('\n'),
    }),
  );

  logger.warn('Cost gate tripped; execution paused pending approval', {
    runId: event.runId,
    estimatedCostUsd: event.estimatedCostUsd,
    ceilingUsd: event.ceilingUsd,
  });
}

export const handler = middy(baseHandler)
  .use(injectLambdaContext(logger))
  .use(captureLambdaHandler(tracer))
  .use(logMetrics(metrics));
