/**
 * The cost gate's pause. Publishes the estimate to the operations topic and hands back the
 * task token, so the execution genuinely waits for a human rather than sending a
 * notification and carrying on.
 */
import { injectLambdaContext } from '@aws-lambda-powertools/logger/middleware';
import { logMetrics } from '@aws-lambda-powertools/metrics/middleware';
import { captureLambdaHandler } from '@aws-lambda-powertools/tracer/middleware';
import middy from '@middy/core';
import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import { COUNTY } from '@oracle-seminole/shared';
import { logger, metrics, tracer } from '../observability';

const sns = new SNSClient({});

export interface AwaitApprovalInput {
  taskToken: string;
  runId: string;
  executionArn: string;
  estimatedCostUsd: number;
  ceilingUsd: number;
  estimatedHours: number;
  ceilingHours: number;
  reasons: string[];
}

async function baseHandler(event: AwaitApprovalInput): Promise<void> {
  const topicArn = process.env.OPERATIONS_TOPIC_ARN;
  if (!topicArn) throw new Error('OPERATIONS_TOPIC_ARN is not set');

  await sns.send(
    new PublishCommand({
      TopicArn: topicArn,
      Subject: `${COUNTY} permit harvest awaiting approval (run ${event.runId})`,
      Message: [
        `Run ${event.runId} is paused at the cost gate.`,
        '',
        `Estimated cost:     $${event.estimatedCostUsd.toFixed(2)} (ceiling $${event.ceilingUsd.toFixed(2)})`,
        `Estimated duration: ${event.estimatedHours.toFixed(1)} h (ceiling ${event.ceilingHours} h)`,
        '',
        'Reasons:',
        ...event.reasons.map((reason) => `  - ${reason}`),
        '',
        `Execution: ${event.executionArn}`,
        '',
        'To proceed, send the task token back to Step Functions:',
        `  aws stepfunctions send-task-success --task-token '${event.taskToken}' --task-output '{}'`,
        '',
        'To refuse:',
        `  aws stepfunctions send-task-failure --task-token '${event.taskToken}' \\`,
        "    --error CostGateRejected --cause 'declined by operator'",
      ].join('\n'),
    }),
  );

  logger.info('Permit harvest paused at the cost gate', {
    runId: event.runId,
    estimatedCostUsd: event.estimatedCostUsd,
    estimatedHours: event.estimatedHours,
    reasons: event.reasons,
  });
}

export const handler = middy(baseHandler)
  .use(injectLambdaContext(logger))
  .use(captureLambdaHandler(tracer))
  .use(logMetrics(metrics));
