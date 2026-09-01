import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import type * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import { ObservableFunction, type ObservableFunctionProps } from './observable-function';

export interface QueueWorkerProps extends Omit<ObservableFunctionProps, 'deadLetterQueue'> {
  /** Single topic that fans out to every channel the team watches, PagerDuty included. */
  alarmTopic: sns.ITopic;
  /** Human-readable alarm name; kept stable so alarm history survives redeploys. */
  alarmName: string;
  /** Deliveries attempted before a message is redriven to the dead-letter queue. */
  maxReceiveCount?: number;
  batchSize?: number;
}

/**
 * A queue-driven worker and the failure plumbing it is required to carry: a source
 * queue with an SQS dead-letter queue behind a redrive policy, and exactly one
 * self-resolving CloudWatch alarm on that dead-letter queue's depth.
 *
 * The alarm is intentionally the only alerting signal for failed items. It fires once
 * on `OK -> ALARM` no matter how many messages land, and returns to `OK` on drain,
 * which auto-resolves the PagerDuty incident subscribed to the topic.
 */
export class QueueWorker extends Construct {
  readonly queue: sqs.Queue;
  readonly deadLetterQueue: sqs.Queue;
  readonly handler: ObservableFunction;
  readonly deadLetterQueueAlarm: cloudwatch.Alarm;

  constructor(scope: Construct, id: string, props: QueueWorkerProps) {
    super(scope, id);

    const functionTimeout = props.timeout ?? cdk.Duration.seconds(30);

    this.deadLetterQueue = new sqs.Queue(this, 'Dlq', {
      retentionPeriod: cdk.Duration.days(14),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
    });

    this.queue = new sqs.Queue(this, 'Queue', {
      // AWS requires the source queue's visibility timeout to exceed the consumer's
      // timeout; six times the function timeout is the documented safe multiple.
      visibilityTimeout: cdk.Duration.seconds(functionTimeout.toSeconds() * 6),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      deadLetterQueue: {
        queue: this.deadLetterQueue,
        maxReceiveCount: props.maxReceiveCount ?? 3,
      },
    });

    this.handler = new ObservableFunction(this, 'Function', {
      ...props,
      timeout: functionTimeout,
    });

    this.handler.addEventSource(
      new SqsEventSource(this.queue, {
        batchSize: props.batchSize ?? 10,
        reportBatchItemFailures: true,
      }),
    );

    this.deadLetterQueueAlarm = new cloudwatch.Alarm(this, 'DlqNotEmpty', {
      alarmName: props.alarmName,
      alarmDescription: `${props.description} dead-letter queue has messages — triage and drain it; this alarm self-resolves on drain.`,
      metric: this.deadLetterQueue.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(1),
        statistic: 'Maximum',
      }),
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    this.deadLetterQueueAlarm.addAlarmAction(new cwActions.SnsAction(props.alarmTopic));
    this.deadLetterQueueAlarm.addOkAction(new cwActions.SnsAction(props.alarmTopic));
  }
}
