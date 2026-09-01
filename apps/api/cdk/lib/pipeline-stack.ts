import {
  METRICS_NAMESPACE,
  operationsTopicName,
  SERVICE_NAME,
  type TargetEnv,
} from '@oracle-seminole/shared';
import * as cdk from 'aws-cdk-lib';
import type * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import type { Construct } from 'constructs';
import { ObservableFunction } from './constructs/observable-function';
import { QueueWorker } from './constructs/queue-worker';

export interface PipelineStackProps extends cdk.StackProps {
  targetEnv: TargetEnv;
  /** Async-invoked notifier that owns the PagerDuty routing key. */
  alertNotifier: lambda.IFunction;
}

/**
 * Orchestration tier: the two Step Functions state machines and the Lambdas they drive.
 *
 * Every state machine wraps its body in a single `Parallel` state purely so one
 * top-level `Catch` covers the whole workflow. That catch routes to a PagerDuty trigger
 * before reaching `Fail`, so a terminal workflow failure can never be silent.
 */
export class PipelineStack extends cdk.Stack {
  readonly seminoleRefresh: sfn.StateMachine;
  readonly permitHarvest: sfn.StateMachine;

  constructor(scope: Construct, id: string, props: PipelineStackProps) {
    super(scope, id, props);

    // Imported by derived ARN rather than passed in from CoreStack. A cross-stack Ref
    // would create a CloudFormation export that this stack pins, which then blocks
    // CoreStack from ever replacing the topic.
    const operationsTopic = sns.Topic.fromTopicArn(
      this,
      'OperationsTopic',
      this.formatArn({ service: 'sns', resource: operationsTopicName(props.targetEnv) }),
    );

    const permitWorker = new QueueWorker(this, 'PermitHarvestWorker', {
      entry: 'src/pipeline/permit-worker.ts',
      description: `${SERVICE_NAME} permit harvest worker`,
      serviceName: SERVICE_NAME,
      metricsNamespace: METRICS_NAMESPACE,
      targetEnv: props.targetEnv,
      alarmTopic: operationsTopic,
      alarmName: `${SERVICE_NAME}-${props.targetEnv}-permit-harvest-dlq-not-empty`,
      memorySize: 512,
      timeout: cdk.Duration.seconds(60),
    });

    const recordRun = new ObservableFunction(this, 'RecordRun', {
      entry: 'src/pipeline/record-run.ts',
      description: `${SERVICE_NAME} run bookkeeping`,
      serviceName: SERVICE_NAME,
      metricsNamespace: METRICS_NAMESPACE,
      targetEnv: props.targetEnv,
      memorySize: 256,
      timeout: cdk.Duration.seconds(30),
    });

    const enqueueParcels = new ObservableFunction(this, 'EnqueueParcels', {
      entry: 'src/pipeline/enqueue-parcels.ts',
      description: `${SERVICE_NAME} permit harvest fan-out`,
      serviceName: SERVICE_NAME,
      metricsNamespace: METRICS_NAMESPACE,
      targetEnv: props.targetEnv,
      memorySize: 256,
      timeout: cdk.Duration.seconds(30),
      environment: {
        PERMIT_QUEUE_URL: permitWorker.queue.queueUrl,
      },
    });

    permitWorker.queue.grantSendMessages(enqueueParcels);

    this.seminoleRefresh = this.buildStateMachine({
      id: 'SeminoleRefresh',
      stateMachineName: 'SeminoleRefresh',
      alertNotifier: props.alertNotifier,
      body: new sfn.Pass(this, 'PrepareRun', {
        parameters: {
          runId: sfn.JsonPath.stringAt('$$.Execution.Name'),
          sources: ['seminole-appraiser', 'seminole-permits'],
        },
      })
        .next(
          new tasks.LambdaInvoke(this, 'RecordRunTask', {
            lambdaFunction: recordRun,
            payload: sfn.TaskInput.fromJsonPathAt('$'),
            outputPath: '$.Payload',
          }),
        )
        .next(new sfn.Pass(this, 'PublishRunSummary')),
    });

    this.permitHarvest = this.buildStateMachine({
      id: 'PermitHarvest',
      stateMachineName: 'PermitHarvest',
      alertNotifier: props.alertNotifier,
      body: new sfn.Pass(this, 'PlanHarvest', {
        parameters: {
          runId: sfn.JsonPath.stringAt('$$.Execution.Name'),
        },
      })
        .next(
          new tasks.LambdaInvoke(this, 'EnqueueParcelsTask', {
            lambdaFunction: enqueueParcels,
            payload: sfn.TaskInput.fromJsonPathAt('$'),
            outputPath: '$.Payload',
          }),
        )
        .next(new sfn.Pass(this, 'HarvestDispatched')),
    });

    new cdk.CfnOutput(this, 'SeminoleRefreshArn', {
      value: this.seminoleRefresh.stateMachineArn,
    });
    new cdk.CfnOutput(this, 'PermitHarvestArn', { value: this.permitHarvest.stateMachineArn });
    new cdk.CfnOutput(this, 'PermitHarvestQueueUrl', { value: permitWorker.queue.queueUrl });
  }

  private buildStateMachine(options: {
    id: string;
    stateMachineName: string;
    body: sfn.IChainable;
    alertNotifier: lambda.IFunction;
  }): sfn.StateMachine {
    const { id, stateMachineName, body, alertNotifier } = options;

    const guarded = new sfn.Parallel(this, `${id}Body`, {
      comment: 'Single-branch wrapper that gives the whole workflow one top-level Catch',
      resultPath: sfn.JsonPath.DISCARD,
    });
    guarded.branch(body);

    const failure = new sfn.Fail(this, `${id}Failed`, {
      comment: 'Terminal failure, reached only after on-call has been paged',
    });

    const pageOnCall = new tasks.LambdaInvoke(this, `${id}PageOnCall`, {
      lambdaFunction: alertNotifier,
      payload: sfn.TaskInput.fromObject({
        summary: sfn.JsonPath.format(
          `${stateMachineName} failed: {}`,
          sfn.JsonPath.stringAt('$.error.Cause'),
        ),
        source: `${SERVICE_NAME}/${stateMachineName}`,
        severity: 'critical',
        dedupKey: sfn.JsonPath.stringAt('$$.Execution.Name'),
        customDetails: {
          stateMachine: stateMachineName,
          executionArn: sfn.JsonPath.stringAt('$$.Execution.Id'),
          errorName: sfn.JsonPath.stringAt('$.error.Error'),
          errorCause: sfn.JsonPath.stringAt('$.error.Cause'),
        },
      }),
      resultPath: sfn.JsonPath.DISCARD,
    });

    // A page that itself fails must not swallow the original failure.
    pageOnCall.addCatch(failure, { resultPath: sfn.JsonPath.DISCARD });

    guarded.addCatch(pageOnCall.next(failure), { resultPath: '$.error' });

    return new sfn.StateMachine(this, id, {
      stateMachineName,
      comment: `${SERVICE_NAME} ${stateMachineName} (Phase 0 stub)`,
      definitionBody: sfn.DefinitionBody.fromChainable(
        guarded.next(new sfn.Succeed(this, `${id}Complete`)),
      ),
      timeout: cdk.Duration.hours(6),
      tracingEnabled: true,
      logs: {
        destination: new logs.LogGroup(this, `${id}Logs`, {
          // `/aws/vendedlogs/states/` is the prefix Step Functions expects; it also
          // exempts the group from the CloudWatch Logs resource-policy size limit.
          logGroupName: `/aws/vendedlogs/states/${stateMachineName}`,
          retention: logs.RetentionDays.THREE_MONTHS,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
        level: sfn.LogLevel.ALL,
        includeExecutionData: true,
      },
    });
  }
}
