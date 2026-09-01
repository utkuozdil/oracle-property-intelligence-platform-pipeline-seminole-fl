import { METRICS_NAMESPACE, SERVICE_NAME, type TargetEnv } from '@oracle-seminole/shared';
import * as cdk from 'aws-cdk-lib';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import type * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import type { Construct } from 'constructs';
import { ObservableFunction } from './constructs/observable-function';

export interface BbbStackProps extends cdk.StackProps {
  targetEnv: TargetEnv;
  /** Async-invoked notifier that owns the PagerDuty routing key. */
  alertNotifier: lambda.IFunction;
  dataBucket: s3.IBucket;
  /** Monthly refresh, so ratings do not drift. Off by default outside prod. */
  scheduleEnabled?: boolean;
}

/**
 * BBB contractor-reputation harvesting.
 *
 * Deliberately the simplest shape in this repository: one Lambda behind a one-task state
 * machine, with no Distributed Map, no sharding, and no cost gate.
 *
 * That is a consequence of the source's size, not an omission. A run is ~152 requests — seven
 * city seed searches at 15 pages each, plus one lookup per permit contractor — and the
 * politeness ceiling of about one request per second is what sets the wall clock at roughly
 * four minutes. Sharding across workers would multiply the request rate at bbb.org while
 * saving nothing worth having, and a cost gate would guard an eight-cent invocation.
 *
 * There is no Chromium tier here, and there should not be one. BBB serves complete results to
 * a plain HTTPS GET; see `docs/seminole-bbb-findings.md`.
 *
 * The state machine exists for the same reason the permit one does — a top-level `Catch` that
 * pages on-call, and an execution history that records what each run harvested.
 */
export class BbbStack extends cdk.Stack {
  readonly stateMachine: sfn.StateMachine;

  constructor(scope: Construct, id: string, props: BbbStackProps) {
    super(scope, id, props);

    const shared = {
      serviceName: SERVICE_NAME,
      metricsNamespace: METRICS_NAMESPACE,
      targetEnv: props.targetEnv,
    } as const;

    /**
     * Memory is 1 GB for network throughput rather than footprint, and the timeout is
     * fifteen minutes against a measured four: the whole point of the ledger is that a
     * re-run is nearly free, so a run that ends up doing every lookup from cold still has to
     * fit. A contractor list several times the current 47 would need the list split across
     * invocations, which is the one reason this would stop being a single Lambda.
     */
    const harvestBbb = new ObservableFunction(this, 'HarvestBbb', {
      ...shared,
      entry: 'src/bbb/harvest-bbb.ts',
      description: `${SERVICE_NAME} BBB contractor reputation harvest`,
      memorySize: 1024,
      timeout: cdk.Duration.minutes(15),
      environment: { DATA_BUCKET: props.dataBucket.bucketName },
      /**
       * One instance, ever. The in-process pacing is a *rate* ceiling against a third-party
       * public site, and two concurrent invocations would double it while each still believed
       * it was being polite.
       */
      reservedConcurrentExecutions: 1,
    });
    // Reads the staged permit census for contractor names and the ledger for idempotency.
    props.dataBucket.grantReadWrite(harvestBbb);

    this.stateMachine = this.buildStateMachine({
      alertNotifier: props.alertNotifier,
      harvestBbb,
    });

    /**
     * Monthly, because a BBB letter grade moves on the order of months and the ledger's
     * freshness window is 30 days — a more frequent schedule would re-fetch nothing and
     * still walk the whole contractor list.
     */
    new events.Rule(this, 'BbbHarvestSchedule', {
      description: `${SERVICE_NAME} monthly BBB reputation refresh`,
      schedule: events.Schedule.cron({ minute: '0', hour: '7', day: '1', month: '*' }),
      enabled: props.scheduleEnabled ?? props.targetEnv === 'prod',
      targets: [new targets.SfnStateMachine(this.stateMachine, { input: events.RuleTargetInput.fromObject({}) })],
    });

    new cdk.CfnOutput(this, 'BbbHarvestStateMachineArn', {
      value: this.stateMachine.stateMachineArn,
    });
  }

  private buildStateMachine(options: {
    harvestBbb: lambda.IFunction;
    alertNotifier: lambda.IFunction;
  }): sfn.StateMachine {
    const stateMachineName = 'SeminoleBbbHarvest';
    const runId = sfn.JsonPath.stringAt('$$.Execution.Name');

    const harvestTask = new tasks.LambdaInvoke(this, 'HarvestBbbTask', {
      lambdaFunction: options.harvestBbb,
      payload: sfn.TaskInput.fromObject({
        runId,
        // Passed whole and defaulted in the handler, because `{}` is what a schedule sends.
        request: sfn.JsonPath.objectAt('$$.Execution.Input'),
      }),
      resultPath: '$.bbb',
      payloadResponseOnly: true,
    });
    harvestTask.addRetry({
      errors: [
        'Lambda.ServiceException',
        'Lambda.AWSLambdaException',
        'Lambda.SdkClientException',
        'Lambda.TooManyRequestsException',
        'TransientRequestError',
      ],
      interval: cdk.Duration.seconds(30),
      maxAttempts: 2,
      backoffRate: 2,
    });
    /**
     * `BbbBlockedError` is absent from that list on purpose. If bbb.org starts refusing, the
     * answer is to stop and be told — not to retry into a rate limit and lose the one access
     * path this tier has.
     */

    const guarded = new sfn.Parallel(this, 'BbbHarvestBody', {
      comment: 'Single-branch wrapper that gives the whole workflow one top-level Catch',
      outputPath: '$[0]',
    });
    guarded.branch(harvestTask);

    const failure = new sfn.Fail(this, 'BbbHarvestFailed', {
      comment: 'Terminal failure, reached only after on-call has been paged',
    });

    const pageOnCall = new tasks.LambdaInvoke(this, 'BbbHarvestPageOnCall', {
      lambdaFunction: options.alertNotifier,
      payload: sfn.TaskInput.fromObject({
        summary: sfn.JsonPath.format(
          `${stateMachineName} failed: {}`,
          sfn.JsonPath.stringAt('$.error.Cause'),
        ),
        source: `${SERVICE_NAME}/${stateMachineName}`,
        // Reputation enrichment failing is not a page-at-3am event; the permit and parcel
        // tiers are. A warning is raised, and the next monthly run retries from the ledger.
        severity: 'warning',
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

    return new sfn.StateMachine(this, 'BbbHarvestStateMachine', {
      stateMachineName,
      comment: `${SERVICE_NAME} BBB contractor reputation harvest`,
      definitionBody: sfn.DefinitionBody.fromChainable(
        guarded.next(new sfn.Succeed(this, 'BbbHarvestComplete')),
      ),
      // A cold run is ~4 minutes; this is the outer bound behind the Lambda's own timeout.
      timeout: cdk.Duration.hours(1),
      tracingEnabled: true,
      logs: {
        destination: new logs.LogGroup(this, 'BbbHarvestLogs', {
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

/**
 * Not registered in `cdk/bin/app.ts`.
 *
 * `app.ts` is being edited by another agent in this repo right now, and `PermitStack` is in
 * exactly the same state, so adding it would create a conflict for no benefit before either
 * tier is deployed. Registering it is one statement:
 *
 *   new BbbStack(app, `${stackPrefix}-Bbb`, {
 *     targetEnv, tags, env: { account, region },
 *     alertNotifier: core.alertNotifier.handler,
 *     dataBucket: core.dataBucket,
 *   });
 */
