import {
  METRICS_NAMESPACE,
  operationsTopicName,
  SERVICE_NAME,
  type TargetEnv,
} from '@oracle-seminole/shared';
import * as cdk from 'aws-cdk-lib';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import type * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import type { Construct } from 'constructs';
import { ObservableFunction } from './constructs/observable-function';

export interface PermitStackProps extends cdk.StackProps {
  targetEnv: TargetEnv;
  /** Async-invoked notifier that owns the PagerDuty routing key. */
  alertNotifier: lambda.IFunction;
  dataBucket: s3.IBucket;
  table: dynamodb.ITableV2;
  /** Weekly permit sweep. Defaults on so the schedule is real in every environment. */
  scheduleEnabled?: boolean;
}

/**
 * Seminole County permit harvesting: the two-source workflow and the workers it drives.
 *
 * Standalone by design. It composes onto `CoreStack` through the bucket, table, and
 * notifier it is handed, and shares nothing with `PipelineStack` — including the state
 * machine name, which is `SeminolePermitHarvest` rather than the `PermitHarvest` stub
 * `PipelineStack` still owns.
 *
 * Shape of the workflow, and why:
 *
 *   PlanSweep -> PredictCost -> [AwaitApproval] -> WaitForPortal
 *     -> CensusSweep (Distributed Map, Source A)  -> ReconcileCensus
 *     -> PlanStatus -> StatusSweep (Distributed Map, Source B) -> ReconcileStatus
 *
 * Source A is a hard prerequisite for Source B, not a parallel branch: Source B's only
 * cap-free lookup is by application number, and application numbers only exist in Source A's
 * census. Every other Source B search silently truncates at 50 rows.
 *
 * Both maps are throttled by a pair of controls rather than one. `MaxConcurrency` bounds the
 * number of workers, and each worker's `reservedConcurrentExecutions` bounds it again at the
 * account level — because the portals impose a *rate* limit and a map's concurrency is only
 * parallelism. The in-process request limiter inside each worker is the third and binding
 * control. An F5 BIG-IP ASM sits in front of Source B and its ceiling was deliberately never
 * probed, so all three are set below the highest level that has evidence behind it.
 */
export class PermitStack extends cdk.Stack {
  readonly stateMachine: sfn.StateMachine;

  constructor(scope: Construct, id: string, props: PermitStackProps) {
    super(scope, id, props);

    // Must be set before the Distributed Maps are constructed: `ResultWriterV2` is read
    // through a feature flag on the construct tree.
    this.node.setContext('@aws-cdk/aws-stepfunctions:useDistributedMapResultWriterV2', true);

    const operationsTopic = sns.Topic.fromTopicArn(
      this,
      'OperationsTopic',
      this.formatArn({ service: 'sns', resource: operationsTopicName(props.targetEnv) }),
    );

    const shared = {
      serviceName: SERVICE_NAME,
      metricsNamespace: METRICS_NAMESPACE,
      targetEnv: props.targetEnv,
    } as const;

    const planSweep = new ObservableFunction(this, 'PlanPermitSweep', {
      ...shared,
      entry: 'src/permits/plan-sweep.ts',
      description: `${SERVICE_NAME} permit sweep planner`,
      memorySize: 512,
      timeout: cdk.Duration.seconds(60),
      environment: { DATA_BUCKET: props.dataBucket.bucketName },
    });
    props.dataBucket.grantWrite(planSweep);

    const predictCost = new ObservableFunction(this, 'PredictPermitCost', {
      ...shared,
      entry: 'src/permits/predict-cost.ts',
      description: `${SERVICE_NAME} permit harvest cost prediction`,
      memorySize: 256,
      // Pure arithmetic over the plan; it touches neither portal nor the bucket.
      timeout: cdk.Duration.seconds(30),
    });

    const awaitApproval = new ObservableFunction(this, 'AwaitPermitApproval', {
      ...shared,
      entry: 'src/permits/await-approval.ts',
      description: `${SERVICE_NAME} permit cost-gate approval notifier`,
      memorySize: 256,
      timeout: cdk.Duration.seconds(30),
      environment: { OPERATIONS_TOPIC_ARN: operationsTopic.topicArn },
    });
    operationsTopic.grantPublish(awaitApproval);

    /**
     * Source A worker.
     *
     * Memory is 1 GB for throughput rather than footprint: a month of `ALL TYPES` is 38
     * pages of ~230 KB HTML, each written to S3 and parsed, and memory buys network on
     * Lambda. Ten minutes is roughly ten times the measured cost of the largest month
     * (38 pages at ~0.6 s plus jittered pacing), which leaves room for the 2005 housing-boom
     * peak of ~3,800 rows in a month without splitting the shard.
     */
    const harvestCensus = new ObservableFunction(this, 'HarvestPermitCensus', {
      ...shared,
      entry: 'src/permits/harvest-census.ts',
      description: `${SERVICE_NAME} permit census worker (Source A)`,
      memorySize: 1024,
      timeout: cdk.Duration.minutes(10),
      environment: { DATA_BUCKET: props.dataBucket.bucketName },
      // The account-level half of the rate ceiling. Two in flight against a single county
      // IIS box on a non-standard port with a daily maintenance window.
      reservedConcurrentExecutions: 2,
    });
    // Read as well as write: the worker merges its sweep into the month's accumulated rows,
    // which means reading the object back and writing it under an ETag precondition.
    props.dataBucket.grantReadWrite(harvestCensus);

    const reconcileCensus = new ObservableFunction(this, 'ReconcilePermitCensus', {
      ...shared,
      entry: 'src/permits/reconcile-census.ts',
      description: `${SERVICE_NAME} permit census reconciliation`,
      // Holds the run's row keys plus the published snapshot's parcel-id column, because the
      // parcel join is a real set intersection rather than a count of well-formed ids.
      memorySize: 2048,
      timeout: cdk.Duration.minutes(10),
      environment: { DATA_BUCKET: props.dataBucket.bucketName },
    });
    props.dataBucket.grantReadWrite(reconcileCensus);

    const planStatus = new ObservableFunction(this, 'PlanPermitStatus', {
      ...shared,
      entry: 'src/permits/plan-status.ts',
      description: `${SERVICE_NAME} permit status worklist planner`,
      memorySize: 2048,
      timeout: cdk.Duration.minutes(10),
      environment: {
        DATA_BUCKET: props.dataBucket.bucketName,
        TABLE_NAME: props.table.tableName,
      },
    });
    props.dataBucket.grantReadWrite(planStatus);
    props.table.grantReadData(planStatus);

    /**
     * Source B worker, pinned to exactly one concurrent execution.
     *
     * This is the single-instance-with-an-internal-throttle shape. A batch of 150 permits at
     * ~2.3 s each, three at a time, is roughly two minutes; the ten-minute timeout covers a
     * batch where every permit is closed and therefore needs the second request for its
     * inspections.
     */
    const harvestStatus = new ObservableFunction(this, 'HarvestPermitStatus', {
      ...shared,
      entry: 'src/permits/harvest-status.ts',
      description: `${SERVICE_NAME} permit status worker (Source B)`,
      memorySize: 1024,
      timeout: cdk.Duration.minutes(10),
      environment: {
        DATA_BUCKET: props.dataBucket.bucketName,
        TABLE_NAME: props.table.tableName,
      },
      reservedConcurrentExecutions: 1,
    });
    props.dataBucket.grantReadWrite(harvestStatus);
    props.table.grantReadWriteData(harvestStatus);

    const reconcileStatus = new ObservableFunction(this, 'ReconcilePermitStatus', {
      ...shared,
      entry: 'src/permits/reconcile-status.ts',
      description: `${SERVICE_NAME} permit status reconciliation`,
      memorySize: 1024,
      timeout: cdk.Duration.minutes(10),
      environment: {
        DATA_BUCKET: props.dataBucket.bucketName,
        OPERATIONS_TOPIC_ARN: operationsTopic.topicArn,
      },
    });
    props.dataBucket.grantReadWrite(reconcileStatus);
    operationsTopic.grantPublish(reconcileStatus);

    this.stateMachine = this.buildStateMachine({
      alertNotifier: props.alertNotifier,
      body: this.buildHarvestBody({
        dataBucket: props.dataBucket,
        planSweep,
        predictCost,
        awaitApproval,
        harvestCensus,
        reconcileCensus,
        planStatus,
        harvestStatus,
        reconcileStatus,
      }),
    });

    /**
     * Weekly rather than nightly. A sweep walks month-windows against a county portal
     * that is rate-limited by courtesy, so it is the most expensive source we have in
     * requests; and a roofing permit's status moves over weeks, not hours. Sunday 09:00
     * UTC keeps it clear of the nightly roll refresh and the monthly BBB run.
     *
     * `{}` is the input on purpose — the workflow's plan step derives its own window,
     * which is what makes an unattended run possible.
     */
    new events.Rule(this, 'PermitHarvestSchedule', {
      description: `${SERVICE_NAME} weekly permit sweep`,
      schedule: events.Schedule.cron({ minute: '0', hour: '9', weekDay: 'SUN' }),
      enabled: props.scheduleEnabled ?? true,
      targets: [
        new targets.SfnStateMachine(this.stateMachine, {
          input: events.RuleTargetInput.fromObject({}),
        }),
      ],
    });

    new cdk.CfnOutput(this, 'PermitHarvestStateMachineArn', {
      value: this.stateMachine.stateMachineArn,
    });
    new cdk.CfnOutput(this, 'PermitCensusWorkerName', {
      value: harvestCensus.functionName,
    });
  }

  private buildHarvestBody(options: {
    dataBucket: s3.IBucket;
    planSweep: lambda.IFunction;
    predictCost: lambda.IFunction;
    awaitApproval: lambda.IFunction;
    harvestCensus: lambda.IFunction;
    reconcileCensus: lambda.IFunction;
    planStatus: lambda.IFunction;
    harvestStatus: lambda.IFunction;
    reconcileStatus: lambda.IFunction;
  }): sfn.IChainable {
    const runId = sfn.JsonPath.stringAt('$$.Execution.Name');

    /**
     * Retries on the states that talk to something outside this account.
     *
     * These live on the states *inside* each item processor rather than on the map, which is
     * what makes a single flaky shard cheap: the map's built-in redrive handles a failed
     * shard, and these handle a failed request inside a shard that is otherwise fine.
     */
    const transientRetry: sfn.RetryProps = {
      errors: [
        'Lambda.ServiceException',
        'Lambda.AWSLambdaException',
        'Lambda.SdkClientException',
        'Lambda.TooManyRequestsException',
        'TransientRequestError',
        'CensusShortfallError',
      ],
      interval: cdk.Duration.seconds(10),
      maxAttempts: 3,
      backoffRate: 2,
    };

    const planSweepTask = new tasks.LambdaInvoke(this, 'PlanSweepTask', {
      lambdaFunction: options.planSweep,
      payload: sfn.TaskInput.fromObject({
        runId,
        // Passed whole and defaulted in the handler: ASL cannot express "this field or a
        // default", and `{}` has to stay a valid input because that is what a schedule sends.
        request: sfn.JsonPath.objectAt('$$.Execution.Input'),
      }),
      resultPath: '$.plan',
      payloadResponseOnly: true,
    });
    planSweepTask.addRetry(transientRetry);

    const predictCostTask = new tasks.LambdaInvoke(this, 'PredictPermitCostTask', {
      lambdaFunction: options.predictCost,
      payload: sfn.TaskInput.fromObject({ runId, plan: sfn.JsonPath.objectAt('$.plan') }),
      resultPath: '$.cost',
      payloadResponseOnly: true,
    });
    predictCostTask.addRetry(transientRetry);

    const awaitApprovalTask = new tasks.LambdaInvoke(this, 'AwaitPermitApprovalTask', {
      lambdaFunction: options.awaitApproval,
      integrationPattern: sfn.IntegrationPattern.WAIT_FOR_TASK_TOKEN,
      payload: sfn.TaskInput.fromObject({
        taskToken: sfn.JsonPath.taskToken,
        runId,
        executionArn: sfn.JsonPath.stringAt('$$.Execution.Id'),
        estimatedCostUsd: sfn.JsonPath.numberAt('$.cost.estimatedCostUsd'),
        ceilingUsd: sfn.JsonPath.numberAt('$.cost.ceilingUsd'),
        estimatedHours: sfn.JsonPath.numberAt('$.cost.estimatedHours'),
        ceilingHours: sfn.JsonPath.numberAt('$.cost.ceilingHours'),
        reasons: sfn.JsonPath.listAt('$.cost.reasons'),
      }),
      // A gate nobody answers must not hold an execution open indefinitely.
      taskTimeout: sfn.Timeout.duration(cdk.Duration.hours(24)),
      resultPath: sfn.JsonPath.DISCARD,
    });

    /**
     * The daily 23:30–07:00 Eastern outage on Source A.
     *
     * `PlanSweep` returns an absolute instant rather than a duration, so the wait is correct
     * across the two days a year when 07:00 Eastern is not a fixed number of hours away. A
     * run that starts outside the window gets `waitUntil: null` and skips this entirely.
     */
    const waitForPortal = new sfn.Wait(this, 'WaitForPortalWindow', {
      time: sfn.WaitTime.timestampPath('$.plan.waitUntil'),
    });

    const censusShardTask = new tasks.LambdaInvoke(this, 'HarvestCensusShardTask', {
      lambdaFunction: options.harvestCensus,
      /**
       * No `payload`, deliberately. Inside a Distributed Map the state input *is* the item, so
       * omitting the payload passes the shard straight through. Writing
       * `TaskInput.fromJsonPathAt('$')` instead renders `"Parameters": "$"`, which hands the
       * worker the literal two-character string `"$"` rather than the shard — measured here,
       * and the shard schema is what turned it into an immediate failure instead of a run that
       * harvested nothing and reported success.
       */
      payloadResponseOnly: true,
    });
    censusShardTask.addRetry(transientRetry);

    const censusSweep = new sfn.DistributedMap(this, 'CensusSweep', {
      itemsPath: '$.plan.shards',
      // Parallelism, not a rate limit — the worker's reserved concurrency and its in-process
      // sequencing are what actually bound the request rate.
      maxConcurrency: 2,
      /**
       * No tolerated-failure field at all, which is Step Functions' zero-tolerance default: a
       * single failed month is a hole in the census, and the map's redrive is the recovery
       * path. Passing `toleratedFailureCount: 0` explicitly would be worse than passing
       * nothing — CDK guards that property on truthiness, so 0 is dropped from the template
       * and the intent would read as configured while having no effect.
       */
      resultWriterV2: new sfn.ResultWriterV2({
        bucket: options.dataBucket,
        prefix: sfn.JsonPath.format('manifests/permits/{}/census-map', runId),
      }),
      resultPath: '$.census',
    });
    censusSweep.itemProcessor(censusShardTask);

    const reconcileCensusTask = new tasks.LambdaInvoke(this, 'ReconcileCensusTask', {
      lambdaFunction: options.reconcileCensus,
      payload: sfn.TaskInput.fromObject({
        runId,
        scope: sfn.JsonPath.objectAt('$.plan.scope'),
      }),
      resultPath: '$.censusSummary',
      payloadResponseOnly: true,
    });
    reconcileCensusTask.addRetry(transientRetry);

    const planStatusTask = new tasks.LambdaInvoke(this, 'PlanStatusTask', {
      lambdaFunction: options.planStatus,
      payload: sfn.TaskInput.fromObject({
        runId,
        scope: sfn.JsonPath.objectAt('$.plan.scope'),
      }),
      resultPath: '$.statusPlan',
      payloadResponseOnly: true,
    });
    planStatusTask.addRetry(transientRetry);

    const statusBatchTask = new tasks.LambdaInvoke(this, 'HarvestStatusBatchTask', {
      lambdaFunction: options.harvestStatus,
      // The batch item is the state input; see `HarvestCensusShardTask` on why there is no payload.
      payloadResponseOnly: true,
    });
    statusBatchTask.addRetry(transientRetry);

    const statusSweep = new sfn.DistributedMap(this, 'StatusSweep', {
      itemsPath: '$.statusPlan.batches',
      // One child at a time. The worker is pinned to one instance anyway, so a higher value
      // would only queue children against a function that cannot scale out.
      maxConcurrency: 1,
      // Status is an enrichment, not the census. A handful of permits whose detail page will
      // not render must not fail a run that has already landed its rows.
      toleratedFailurePercentage: 5,
      resultWriterV2: new sfn.ResultWriterV2({
        bucket: options.dataBucket,
        prefix: sfn.JsonPath.format('manifests/permits/{}/status-map', runId),
      }),
      resultPath: '$.status',
    });
    statusSweep.itemProcessor(statusBatchTask);

    const reconcileStatusTask = new tasks.LambdaInvoke(this, 'ReconcileStatusTask', {
      lambdaFunction: options.reconcileStatus,
      payload: sfn.TaskInput.fromObject({ runId }),
      resultPath: '$.statusSummary',
      payloadResponseOnly: true,
    });
    reconcileStatusTask.addRetry(transientRetry);

    const statusPlannedChoice = new sfn.Choice(this, 'AnyPermitsToStatus?')
      .when(
        // An empty batch list would make the Distributed Map iterate nothing, which reads as
        // a successful status sweep that harvested no permits.
        sfn.Condition.isPresent('$.statusPlan.batches[0]'),
        statusSweep.next(reconcileStatusTask),
      )
      .otherwise(new sfn.Pass(this, 'NoPermitsInStatusWindow'));

    /**
     * The census-only branch is taken *before* the planner rather than after it. Planning is
     * not free — it reads every census row back and writes a batch object per 150 permits — so
     * a census-only run that planned first did all of that and then discarded it.
     */
    const censusOnlyChoice = new sfn.Choice(this, 'StatusRequested?')
      .when(
        sfn.Condition.booleanEquals('$.plan.scope.censusOnly', true),
        new sfn.Pass(this, 'CensusOnlyRun'),
      )
      .otherwise(planStatusTask.next(statusPlannedChoice));

    const censusChain = censusSweep.next(reconcileCensusTask).next(censusOnlyChoice);

    const portalWindowChoice = new sfn.Choice(this, 'PortalAvailable?')
      .when(sfn.Condition.isNull('$.plan.waitUntil'), censusChain)
      .otherwise(waitForPortal.next(censusChain));

    const overBudgetChoice = new sfn.Choice(this, 'OverBudget?')
      .when(
        sfn.Condition.stringEquals('$.cost.status', 'APPROVAL_REQUIRED'),
        awaitApprovalTask.next(portalWindowChoice),
      )
      .otherwise(portalWindowChoice);

    return planSweepTask.next(predictCostTask).next(overBudgetChoice);
  }

  /**
   * Wraps the workflow in a single-branch `Parallel` so one top-level `Catch` covers all of
   * it, and routes that catch to the PagerDuty trigger before `Fail`. A batch run must never
   * fail silently, and the notifier is the only path that pages.
   *
   * The `Parallel`'s single branch result becomes the execution output, so what a run
   * harvested is the first thing `describe-execution` shows rather than something that
   * exists only inside the history.
   */
  private buildStateMachine(options: {
    body: sfn.IChainable;
    alertNotifier: lambda.IFunction;
  }): sfn.StateMachine {
    const stateMachineName = 'SeminolePermitHarvest';

    const guarded = new sfn.Parallel(this, 'PermitHarvestBody', {
      comment: 'Single-branch wrapper that gives the whole workflow one top-level Catch',
      outputPath: '$[0]',
    });
    guarded.branch(options.body);

    const failure = new sfn.Fail(this, 'PermitHarvestFailed', {
      comment: 'Terminal failure, reached only after on-call has been paged',
    });

    const pageOnCall = new tasks.LambdaInvoke(this, 'PermitHarvestPageOnCall', {
      lambdaFunction: options.alertNotifier,
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

    return new sfn.StateMachine(this, 'PermitHarvestStateMachine', {
      stateMachineName,
      comment: `${SERVICE_NAME} Seminole permit harvest (Source A census + Source B status)`,
      definitionBody: sfn.DefinitionBody.fromChainable(
        guarded.next(new sfn.Succeed(this, 'PermitHarvestComplete')),
      ),
      // A full 31-year census is under 4 h and a 24-month status window ~1.2 h; the cost
      // gate refuses anything projected past 12 h, and this is the outer bound behind it.
      timeout: cdk.Duration.hours(20),
      tracingEnabled: true,
      logs: {
        destination: new logs.LogGroup(this, 'PermitHarvestLogs', {
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
