import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import type * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import { ObservableFunction, type ObservableFunctionProps } from './observable-function';

export interface AsyncObservableFunctionProps extends Omit<
  ObservableFunctionProps,
  'deadLetterQueue'
> {
  /** Single topic that fans out to every channel the team watches, PagerDuty included. */
  alarmTopic: sns.ITopic;
  /** Human-readable alarm name; kept stable so alarm history survives redeploys. */
  alarmName: string;
}

/**
 * An asynchronously invoked Lambda plus the failure plumbing it is required to carry:
 * an SQS dead-letter queue and exactly one self-resolving CloudWatch alarm on that
 * queue's depth.
 *
 * The alarm is intentionally the only alerting signal for failed items. It fires once
 * on `OK -> ALARM` no matter how many messages land, and returns to `OK` on drain,
 * which auto-resolves the PagerDuty incident subscribed to the topic.
 */
export class AsyncObservableFunction extends Construct {
  readonly handler: ObservableFunction;
  readonly deadLetterQueue: sqs.Queue;
  readonly deadLetterQueueAlarm: cloudwatch.Alarm;

  constructor(scope: Construct, id: string, props: AsyncObservableFunctionProps) {
    super(scope, id);

    this.deadLetterQueue = new sqs.Queue(this, 'Dlq', {
      retentionPeriod: cdk.Duration.days(14),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
    });

    this.handler = new ObservableFunction(this, 'Function', {
      ...props,
      deadLetterQueue: this.deadLetterQueue,
    });

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
