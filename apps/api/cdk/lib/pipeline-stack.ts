import {
  glueJobName,
  METRICS_NAMESPACE,
  operationsTopicName,
  SERVICE_NAME,
  type TargetEnv,
} from '@oracle-seminole/shared';
import * as cdk from 'aws-cdk-lib';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import type * as s3 from 'aws-cdk-lib/aws-s3';
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
  dataBucket: s3.IBucket;
  table: dynamodb.ITableV2;
  /** Nightly property-roll refresh. Defaults on: the workflow is built to be run nightly. */
  refreshScheduleEnabled?: boolean;
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
      timeout: cdk.Duration.seconds(60),
      environment: {
        DATA_BUCKET: props.dataBucket.bucketName,
        TABLE_NAME: props.table.tableName,
      },
    });
    props.dataBucket.grantRead(recordRun);
    props.table.grantReadWriteData(recordRun);

    const predictCost = new ObservableFunction(this, 'PredictCost', {
      entry: 'src/pipeline/predict-cost.ts',
      description: `${SERVICE_NAME} transform cost prediction`,
      serviceName: SERVICE_NAME,
      metricsNamespace: METRICS_NAMESPACE,
      targetEnv: props.targetEnv,
      memorySize: 256,
      // One HEAD against a slow county web server, with a 30s in-handler timeout.
      timeout: cdk.Duration.seconds(60),
    });

    const awaitApproval = new ObservableFunction(this, 'AwaitApproval', {
      entry: 'src/pipeline/await-approval.ts',
      description: `${SERVICE_NAME} cost-gate approval notifier`,
      serviceName: SERVICE_NAME,
      metricsNamespace: METRICS_NAMESPACE,
      targetEnv: props.targetEnv,
      memorySize: 256,
      timeout: cdk.Duration.seconds(30),
      environment: {
        OPERATIONS_TOPIC_ARN: operationsTopic.topicArn,
      },
    });
    operationsTopic.grantPublish(awaitApproval);

    /**
     * The refresh state machine's ARN, composed rather than referenced.
     *
     * `FetchRoll` has to name the state machine that invokes it, to see whether a twin
     * execution is already running. Taking that from `stateMachine.stateMachineArn`
     * would put the function's policy downstream of the state machine and the state
     * machine's role downstream of the function — a CloudFormation cycle. The name is
     * fixed and set explicitly below, so composing the ARN breaks the cycle without
     * weakening the grant, which still resolves to exactly one resource.
     */
    const refreshArn = cdk.Stack.of(this).formatArn({
      service: 'states',
      resource: 'stateMachine',
      resourceName: 'SeminoleRefresh',
      arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
    });

    const fetchRoll = new ObservableFunction(this, 'FetchRoll', {
      entry: 'src/pipeline/fetch-roll.ts',
      description: `${SERVICE_NAME} CAMA archive acquisition`,
      serviceName: SERVICE_NAME,
      metricsNamespace: METRICS_NAMESPACE,
      targetEnv: props.targetEnv,
      // The 95 MB archive is buffered to hash it before it is stored, so memory has to
      // clear the archive plus headroom. Memory also buys network throughput on Lambda.
      memorySize: 2048,
      timeout: cdk.Duration.minutes(10),
      environment: {
        DATA_BUCKET: props.dataBucket.bucketName,
        TABLE_NAME: props.table.tableName,
        STATE_MACHINE_ARN: refreshArn,
      },
      // The source is one county web server. Exactly one acquisition may be in flight
      // at a time, and this is the hard ceiling behind the ledger and the twin check.
      reservedConcurrentExecutions: 1,
    });
    const fetchFdor = new ObservableFunction(this, 'FetchFdor', {
      entry: 'src/pipeline/fetch-fdor.ts',
      description: `${SERVICE_NAME} FDOR second-source acquisition`,
      serviceName: SERVICE_NAME,
      metricsNamespace: METRICS_NAMESPACE,
      targetEnv: props.targetEnv,
      // 124 MiB across 121 windows, eight in flight. No single response is large, but
      // memory is also what buys network throughput on Lambda and the whole county has
      // to land inside the timeout.
      memorySize: 2048,
      // Measured at 65 s for the full county. Ten minutes is the outer bound for a
      // republished layer that is slower or denser than the one measured.
      timeout: cdk.Duration.minutes(10),
      environment: {
        DATA_BUCKET: props.dataBucket.bucketName,
        TABLE_NAME: props.table.tableName,
      },
      // One acquisition of this source in flight at a time, matching `FetchRoll`. The
      // pointer swap at the end is what two concurrent acquisitions would race.
      reservedConcurrentExecutions: 1,
    });
    props.dataBucket.grantReadWrite(fetchFdor);
    props.table.grantReadWriteData(fetchFdor);

    const publishSnapshot = new ObservableFunction(this, 'PublishSnapshot', {
      entry: 'src/pipeline/publish-snapshot.ts',
      description: `${SERVICE_NAME} snapshot publication`,
      serviceName: SERVICE_NAME,
      metricsNamespace: METRICS_NAMESPACE,
      targetEnv: props.targetEnv,
      memorySize: 512,
      // Server-side copies, so the 39 MB never enters the function; the time is spent in
      // 56 sequential S3 round trips plus two listings.
      timeout: cdk.Duration.minutes(5),
      environment: {
        DATA_BUCKET: props.dataBucket.bucketName,
      },
    });
    props.dataBucket.grantReadWrite(publishSnapshot);

    const announceDryRun = new ObservableFunction(this, 'AnnounceDryRun', {
      entry: 'src/pipeline/announce-dry-run.ts',
      description: `${SERVICE_NAME} withheld-publication notice`,
      serviceName: SERVICE_NAME,
      metricsNamespace: METRICS_NAMESPACE,
      targetEnv: props.targetEnv,
      memorySize: 256,
      timeout: cdk.Duration.seconds(30),
      environment: {
        OPERATIONS_TOPIC_ARN: operationsTopic.topicArn,
      },
    });
    operationsTopic.grantPublish(announceDryRun);

    props.dataBucket.grantWrite(fetchRoll);
    props.table.grantReadWriteData(fetchRoll);
    fetchRoll.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['states:ListExecutions'],
        resources: [refreshArn],
      }),
    );

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
      surfaceOutput: true,
      body: this.buildRefreshBody({
        targetEnv: props.targetEnv,
        dataBucket: props.dataBucket,
        publishSnapshot,
        announceDryRun,
        predictCost,
        awaitApproval,
        fetchRoll,
        fetchFdor,
        recordRun,
      }),
    });

    /**
     * Nightly, because CAMA rebuilds nightly and `FetchRoll` compares the source ETag
     * against the ledger before anything downstream runs — so a night with no new roll
     * costs one conditional request and stops. Enabled outside prod as well: this is the
     * environment reviewers exercise, and a schedule that exists but never fires is
     * indistinguishable from no schedule at all.
     *
     * 06:00 UTC is roughly 01:00 local, after the county's rebuild window and far from
     * the BBB and places refreshes so the three never contend for the same run history.
     */
    new events.Rule(this, 'SeminoleRefreshSchedule', {
      description: `${SERVICE_NAME} nightly property-roll refresh`,
      schedule: events.Schedule.cron({ minute: '0', hour: '6' }),
      enabled: props.refreshScheduleEnabled ?? true,
      targets: [
        new targets.SfnStateMachine(this.seminoleRefresh, {
          input: events.RuleTargetInput.fromObject({}),
        }),
      ],
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

  /**
   * The Phase 1 refresh chain.
   *
   *   PredictCost -> OverBudget? -> [AwaitApproval] -> FetchRoll -> SourceChanged?
   *     -> FetchFdor -> SeminoleTransform (Glue, .sync) -> RecordRun
   *     -> PublishApproved? -> end
   *
   * Ordering is not arbitrary. Cost prediction is first because it must run before any
   * data is touched, and it is also the only step that reads the source's headers — so
   * `FetchRoll` inherits the size, ETag, and `Last-Modified` rather than issuing a second
   * request to a county web server. `FetchRoll` then owns the skip decision, because the
   * ETag it compares against the ledger is the one the gate already fetched.
   *
   * `FetchFdor` sits on the transform branch only, and is the one step in this workflow
   * whose failure is survivable. FDOR is republished annually against CAMA's nightly
   * rebuild, so on almost every night it has nothing to do; running it on the skipped
   * branch would spend two requests a night confirming that twice over. Its failure is
   * caught rather than propagated, because it refreshes a pointer the transform reads
   * and does not produce anything the night's parcels depend on.
   */
  private buildRefreshBody(options: {
    targetEnv: TargetEnv;
    dataBucket: s3.IBucket;
    predictCost: lambda.IFunction;
    awaitApproval: lambda.IFunction;
    fetchRoll: lambda.IFunction;
    fetchFdor: lambda.IFunction;
    recordRun: lambda.IFunction;
    publishSnapshot: lambda.IFunction;
    announceDryRun: lambda.IFunction;
  }): sfn.IChainable {
    const {
      targetEnv,
      dataBucket,
      predictCost,
      awaitApproval,
      fetchRoll,
      fetchFdor,
      recordRun,
      publishSnapshot,
      announceDryRun,
    } = options;

    // Retries on every task that talks to something outside this account. The source is
    // a county web server and Glue is a shared service; both fail transiently, and a
    // transient failure must not page on-call or waste the download.
    const transientRetry = {
      errors: [
        'Lambda.ServiceException',
        'Lambda.AWSLambdaException',
        'Lambda.SdkClientException',
        'Lambda.TooManyRequestsException',
        'States.TaskFailed',
      ],
      interval: cdk.Duration.seconds(5),
      maxAttempts: 3,
      backoffRate: 2,
    };

    const predictCostTask = new tasks.LambdaInvoke(this, 'PredictCostTask', {
      lambdaFunction: predictCost,
      payload: sfn.TaskInput.fromObject({
        runId: sfn.JsonPath.stringAt('$$.Execution.Name'),
      }),
      resultPath: '$.cost',
      payloadResponseOnly: true,
    });
    predictCostTask.addRetry(transientRetry);

    const awaitApprovalTask = new tasks.LambdaInvoke(this, 'AwaitApprovalTask', {
      lambdaFunction: awaitApproval,
      integrationPattern: sfn.IntegrationPattern.WAIT_FOR_TASK_TOKEN,
      payload: sfn.TaskInput.fromObject({
        taskToken: sfn.JsonPath.taskToken,
        runId: sfn.JsonPath.stringAt('$$.Execution.Name'),
        estimatedCostUsd: sfn.JsonPath.numberAt('$.cost.estimatedCostUsd'),
        ceilingUsd: sfn.JsonPath.numberAt('$.cost.ceilingUsd'),
        executionArn: sfn.JsonPath.stringAt('$$.Execution.Id'),
      }),
      // A gate nobody answers must not hold an execution open indefinitely. One day is
      // long enough for a working day to notice and short enough to self-clear.
      timeout: cdk.Duration.hours(24),
      resultPath: sfn.JsonPath.DISCARD,
    });

    /**
     * The execution's own input, handed to the steps that take options from it.
     *
     * ASL cannot express "this field, or a default if absent", and referencing a missing
     * path is a runtime error rather than a null. Passing the whole object and letting
     * the handler default it keeps `{}` a valid input — which matters, because `{}` is
     * what the nightly schedule will send.
     */
    const executionInput = sfn.JsonPath.objectAt('$$.Execution.Input');

    const fetchRollTask = new tasks.LambdaInvoke(this, 'FetchRollTask', {
      lambdaFunction: fetchRoll,
      payload: sfn.TaskInput.fromObject({
        runId: sfn.JsonPath.stringAt('$$.Execution.Name'),
        source: sfn.JsonPath.objectAt('$.cost.source'),
        executionInput,
      }),
      resultPath: '$.fetch',
      payloadResponseOnly: true,
    });
    fetchRollTask.addRetry(transientRetry);

    const fetchFdorTask = new tasks.LambdaInvoke(this, 'FetchFdorTask', {
      lambdaFunction: fetchFdor,
      payload: sfn.TaskInput.fromObject({
        runId: sfn.JsonPath.stringAt('$$.Execution.Name'),
        executionInput,
      }),
      resultPath: '$.fdor',
      payloadResponseOnly: true,
    });
    fetchFdorTask.addRetry(transientRetry);

    /**
     * The survivable-failure branch, and the reason `FetchFdor` cannot stop the night.
     *
     * ArcGIS Online being unreachable is not a reason to skip a county's nightly parcel
     * refresh. What is lost is the freshness of a snapshot that is republished once a
     * year, so the transform simply reconciles against the snapshot already in force —
     * which it locates through `raw/fdor/current.json` rather than through this step's
     * output, precisely so that this path stays a no-op rather than a special case.
     *
     * The outcome is still written into the execution state, so a run that degraded is
     * distinguishable from one that did not without reading the history.
     */
    const fdorUnavailable = new sfn.Pass(this, 'FdorUnavailable', {
      result: sfn.Result.fromObject({
        skipped: true,
        skipReason: 'unavailable',
        snapshotPrefix: '',
        recordCount: 0,
        requestCount: 0,
        downloadedBytes: 0,
      }),
      resultPath: '$.fdor',
    });
    fetchFdorTask.addCatch(fdorUnavailable, { resultPath: sfn.JsonPath.DISCARD });

    const transformTask = new tasks.GlueStartJobRun(this, 'SeminoleTransform', {
      glueJobName: glueJobName(targetEnv),
      // `.sync` so the execution history holds the Glue run's own outcome. Without it a
      // Glue failure would look like a successful state-machine step.
      integrationPattern: sfn.IntegrationPattern.RUN_JOB,
      arguments: sfn.TaskInput.fromObject({
        '--data_bucket': dataBucket.bucketName,
        '--run_id': sfn.JsonPath.stringAt('$$.Execution.Name'),
        '--source_etag': sfn.JsonPath.stringAt('$.fetch.sourceEtag'),
        '--source_last_modified': sfn.JsonPath.stringAt('$.fetch.sourceLastModified'),
        '--source_fingerprint': sfn.JsonPath.stringAt('$.fetch.sourceFingerprint'),
        // Glue job arguments are strings, so `FetchRoll` returns the year already
        // stringified rather than forcing a `States.Format` here.
        '--snapshot_year': sfn.JsonPath.stringAt('$.fetch.snapshotYear'),
        '--target_env': targetEnv,
      }),
      // The job's own timeout is 60 minutes; this is the outer bound.
      timeout: cdk.Duration.minutes(75),
      resultPath: '$.transform',
    });
    // Glue throttles StartJobRun when the account is busy, and a concurrent-run rejection
    // is worth waiting out rather than failing the night.
    transformTask.addRetry({
      errors: ['Glue.ConcurrentRunsExceededException', 'Glue.AWSGlueException'],
      interval: cdk.Duration.seconds(30),
      maxAttempts: 3,
      backoffRate: 2,
    });

    const recordRunTask = new tasks.LambdaInvoke(this, 'RecordRunTask', {
      lambdaFunction: recordRun,
      payload: sfn.TaskInput.fromObject({
        runId: sfn.JsonPath.stringAt('$$.Execution.Name'),
        skipped: false,
        sourceEtag: sfn.JsonPath.stringAt('$.fetch.sourceEtag'),
        executionInput,
      }),
      resultPath: '$.run',
      payloadResponseOnly: true,
    });
    recordRunTask.addRetry(transientRetry);

    const recordSkippedTask = new tasks.LambdaInvoke(this, 'RecordSkippedRun', {
      lambdaFunction: recordRun,
      payload: sfn.TaskInput.fromObject({
        runId: sfn.JsonPath.stringAt('$$.Execution.Name'),
        skipped: true,
        skipReason: sfn.JsonPath.stringAt('$.fetch.skipReason'),
      }),
      resultPath: '$.run',
      payloadResponseOnly: true,
    });
    recordSkippedTask.addRetry(transientRetry);

    const publishSnapshotTask = new tasks.LambdaInvoke(this, 'PublishSnapshotTask', {
      lambdaFunction: publishSnapshot,
      payload: sfn.TaskInput.fromObject({
        runId: sfn.JsonPath.stringAt('$$.Execution.Name'),
        parcelCount: sfn.JsonPath.numberAt('$.run.parcelCount'),
        partitionCount: sfn.JsonPath.numberAt('$.run.partitionCount'),
      }),
      resultPath: '$.publish',
      payloadResponseOnly: true,
    });
    publishSnapshotTask.addRetry(transientRetry);

    const announceDryRunTask = new tasks.LambdaInvoke(this, 'AnnounceDryRunTask', {
      lambdaFunction: announceDryRun,
      payload: sfn.TaskInput.fromObject({
        runId: sfn.JsonPath.stringAt('$$.Execution.Name'),
        reason: sfn.JsonPath.stringAt('$.run.publishDecision'),
        parcelCount: sfn.JsonPath.numberAt('$.run.parcelCount'),
        partitionCount: sfn.JsonPath.numberAt('$.run.partitionCount'),
      }),
      resultPath: '$.publish',
      payloadResponseOnly: true,
    });
    announceDryRunTask.addRetry(transientRetry);

    const publishChoice = new sfn.Choice(this, 'PublishApproved?')
      .when(sfn.Condition.booleanEquals('$.run.publishApproved', true), publishSnapshotTask)
      // Reached only when the execution input opted out. The branch is a task rather than
      // a Pass on purpose: it has to be impossible for a withheld publish to look like a
      // completed one from the outside.
      .otherwise(announceDryRunTask);

    const sourceChangedChoice = new sfn.Choice(this, 'SourceChanged?')
      .when(
        sfn.Condition.booleanEquals('$.fetch.skipped', true),
        recordSkippedTask.next(new sfn.Pass(this, 'NothingToIngest')),
      )
      .otherwise(fetchFdorTask.next(transformTask.next(recordRunTask).next(publishChoice)));

    // Both the caught and the uncaught path converge on the same transform. Declared
    // after the chain above so `transformTask` already carries its own successors.
    fdorUnavailable.next(transformTask);

    const overBudgetChoice = new sfn.Choice(this, 'OverBudget?')
      .when(
        sfn.Condition.stringEquals('$.cost.status', 'APPROVAL_REQUIRED'),
        awaitApprovalTask.next(fetchRollTask),
      )
      .otherwise(fetchRollTask);

    fetchRollTask.next(sourceChangedChoice);

    return predictCostTask.next(overBudgetChoice);
  }

  private buildStateMachine(options: {
    id: string;
    stateMachineName: string;
    body: sfn.IChainable;
    alertNotifier: lambda.IFunction;
    /**
     * Let the branch's own result become the execution output.
     *
     * Off by default, which discards it. That default is why `describe-execution` showed
     * `{}` for two runs that had staged 181,218 parcels and published none of them — the
     * outcome existed only inside the history. With this on, whether a run published is
     * the first thing anyone reading the execution sees.
     */
    surfaceOutput?: boolean;
  }): sfn.StateMachine {
    const { id, stateMachineName, body, alertNotifier, surfaceOutput = false } = options;

    const guarded = new sfn.Parallel(this, `${id}Body`, {
      comment: 'Single-branch wrapper that gives the whole workflow one top-level Catch',
      // A Parallel returns an array of branch results; there is exactly one branch, so
      // unwrapping it makes the execution output the branch's own object.
      ...(surfaceOutput ? { outputPath: '$[0]' } : { resultPath: sfn.JsonPath.DISCARD }),
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
