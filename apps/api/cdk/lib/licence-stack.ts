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

export interface LicenceStackProps extends cdk.StackProps {
  targetEnv: TargetEnv;
  /** Async-invoked notifier that owns the PagerDuty routing key. */
  alertNotifier: lambda.IFunction;
  dataBucket: s3.IBucket;
  /** Weekly refresh, so licence standing does not drift. */
  scheduleEnabled?: boolean;
}

/**
 * Florida DBPR contractor-licence harvesting.
 *
 * The same deliberately simple shape as the BBB tier — one Lambda behind a one-task state
 * machine, no Distributed Map, no sharding, no cost gate — and for an even stronger reason.
 * A run is **two HTTP requests**: prime a Cloudflare cookie, then download one 48.8 MB CSV.
 * The source is a single object with no server-side filter, so there is nothing to shard, and
 * the host escalates its bot management after roughly twenty requests in a few minutes, so
 * anything that raised the request count would make the tier worse rather than faster. A cost
 * gate would guard a sub-cent invocation.
 *
 * There is no Chromium tier here and there must not be one. DBPR's 403 challenge page ships a
 * `__cf_bm` cookie, and replaying it on the CSV path returns 200 over plain HTTP; see
 * `docs/seminole-licence-findings.md` and the header comment on `src/licences/http.ts`.
 *
 * The state machine exists for the same reasons the permit and BBB ones do — a top-level
 * `Catch` that pages on-call, and an execution history recording what each run harvested.
 */
export class LicenceStack extends cdk.Stack {
  readonly stateMachine: sfn.StateMachine;

  constructor(scope: Construct, id: string, props: LicenceStackProps) {
    super(scope, id, props);

    const shared = {
      serviceName: SERVICE_NAME,
      metricsNamespace: METRICS_NAMESPACE,
      targetEnv: props.targetEnv,
    } as const;

    /**
     * 2 GB of memory for the *payload*, not for CPU.
     *
     * The extract is 48.8 MB of latin-1 bytes, which becomes roughly 97 MB once decoded into a
     * JavaScript string, and the parse pass then holds the county's 5,211 records plus the
     * match indexes over them. The statewide rows are deliberately *not* retained — only the
     * handful whose licence serial a permit name references — which is what keeps this inside
     * a plain zipped Lambda instead of needing Glue or Fargate.
     *
     * The timeout is the 15-minute maximum against a measured 260-second download. That is
     * not slack for its own sake: 188 KB/s is the host's pace, and a slower day has to fit
     * two attempts plus backoff (~810 s worst case) rather than truncate mid-transfer.
     */
    const harvestLicences = new ObservableFunction(this, 'HarvestLicences', {
      ...shared,
      entry: 'src/licences/harvest-licences.ts',
      description: `${SERVICE_NAME} DBPR contractor licence harvest`,
      memorySize: 2048,
      timeout: cdk.Duration.minutes(15),
      environment: { DATA_BUCKET: props.dataBucket.bucketName },
      /**
       * One instance, ever. Two concurrent invocations would double the request rate at a host
       * whose bot management demonstrably escalates, and each would still believe it was
       * making the two polite requests a run is supposed to make.
       */
      reservedConcurrentExecutions: 1,
    });
    // Reads the staged permit census for contractor names and the ledger for idempotency.
    props.dataBucket.grantReadWrite(harvestLicences);

    this.stateMachine = this.buildStateMachine({
      alertNotifier: props.alertNotifier,
      harvestLicences,
    });

    /**
     * Weekly, Wednesday 12:00 UTC.
     *
     * DBPR republishes this file **daily**, not monthly: `Last-Modified` was `Tue, 01 Sep 2026
     * 10:48:27 GMT` when probed at 17:20 the same day. The cadence is therefore a product
     * choice rather than a source constraint, and it is a trade between staleness and cost:
     *
     *  - *Not daily.* An individual contractor's licence standing moves on the order of
     *    months. Thirty runs a month would each pay a 260-second download to report standings
     *    identical to the day before, and would multiply request volume at a host that
     *    escalates.
     *  - *Not monthly.* This is the primary contractor-quality signal in the product, and the
     *    lead it creates — a suspended or lapsed licence against a long-open roofing permit —
     *    is perishable. Up to 30 days of staleness would mean showing a clean licence for a
     *    contractor suspended three weeks ago, which is worse than showing nothing.
     *
     * Weekly bounds staleness at seven days for four downloads a month.
     *
     * Wednesday is chosen rather than arbitrary: the permit harvest runs Sunday 09:00, so by
     * Wednesday its census has landed and the join reads a fresh contractor list.
     *
     * 12:00 UTC because the source is regenerated late morning UTC. An earlier slot would
     * reliably fetch the *previous* day's file, which is a day of staleness taken for nothing;
     * noon clears the observed 10:48 publication with an hour of margin. It is also clear of
     * every other timer in this pipeline — the nightly roll at 06:00, the monthly BBB refresh
     * at 07:00, the Sunday permit harvest at 09:00 — so no two contend for the account's
     * Lambda concurrency.
     */
    new events.Rule(this, 'LicenceHarvestSchedule', {
      description: `${SERVICE_NAME} weekly DBPR contractor licence refresh`,
      schedule: events.Schedule.cron({ minute: '0', hour: '12', weekDay: 'WED' }),
      /**
       * On in dev too. Dev is the environment reviewers exercise, so a schedule that is merely
       * defined and never fires proves nothing; `?? true` makes running the default and leaves
       * disabling it an explicit act.
       */
      enabled: props.scheduleEnabled ?? true,
      targets: [
        new targets.SfnStateMachine(this.stateMachine, {
          input: events.RuleTargetInput.fromObject({}),
        }),
      ],
    });

    new cdk.CfnOutput(this, 'LicenceHarvestStateMachineArn', {
      value: this.stateMachine.stateMachineArn,
    });
  }

  private buildStateMachine(options: {
    harvestLicences: lambda.IFunction;
    alertNotifier: lambda.IFunction;
  }): sfn.StateMachine {
    const stateMachineName = 'SeminoleLicenceHarvest';
    const runId = sfn.JsonPath.stringAt('$$.Execution.Name');

    const harvestTask = new tasks.LambdaInvoke(this, 'HarvestLicencesTask', {
      lambdaFunction: options.harvestLicences,
      payload: sfn.TaskInput.fromObject({
        runId,
        // Passed whole and defaulted in the handler, because `{}` is what a schedule sends.
        request: sfn.JsonPath.objectAt('$$.Execution.Input'),
      }),
      resultPath: '$.licences',
      payloadResponseOnly: true,
    });
    harvestTask.addRetry({
      errors: [
        'Lambda.ServiceException',
        'Lambda.AWSLambdaException',
        'Lambda.SdkClientException',
        'Lambda.TooManyRequestsException',
        'States.Timeout',
        'TransientRequestError',
      ],
      /**
       * This is where the *real* retry lives. A second attempt gets a whole fresh 15-minute
       * budget, which is what a 260-second download that went slowly actually needs — as
       * opposed to squeezing a third in-process attempt into the remainder of the first.
       */
      interval: cdk.Duration.seconds(60),
      maxAttempts: 2,
      backoffRate: 2,
    });
    /**
     * `DbprThrottledError` gets one retry, after five minutes — and this is a deliberate
     * divergence from the BBB tier, which refuses to retry a refusal at all.
     *
     * The difference is that this throttle was *measured* and is self-clearing: escalation
     * showed up as 403s that stopped carrying `Set-Cookie`, and a ~150-second pause restored
     * the identical flow. Five minutes is twice that. So this is not retrying into a rate
     * limit, it is waiting past a known recovery window — and with a weekly schedule the
     * alternative is a week of staleness for a signal whose whole value is being current.
     *
     * One retry, not many. If the host is still refusing after five minutes, something has
     * changed and the right outcome is to be told.
     */
    harvestTask.addRetry({
      errors: ['DbprThrottledError'],
      interval: cdk.Duration.minutes(5),
      maxAttempts: 1,
    });
    /**
     * `ImplausibleExtractError` is absent from both lists on purpose. It means the response
     * was not the extract — a moved URL, a changed layout, or a truncated transfer wearing a
     * 200 — and no amount of retrying fixes any of those. It should page.
     */

    const guarded = new sfn.Parallel(this, 'LicenceHarvestBody', {
      comment: 'Single-branch wrapper that gives the whole workflow one top-level Catch',
      outputPath: '$[0]',
    });
    guarded.branch(harvestTask);

    const failure = new sfn.Fail(this, 'LicenceHarvestFailed', {
      comment: 'Terminal failure, reached only after on-call has been paged',
    });

    const pageOnCall = new tasks.LambdaInvoke(this, 'LicenceHarvestPageOnCall', {
      lambdaFunction: options.alertNotifier,
      payload: sfn.TaskInput.fromObject({
        summary: sfn.JsonPath.format(
          `${stateMachineName} failed: {}`,
          sfn.JsonPath.stringAt('$.error.Cause'),
        ),
        source: `${SERVICE_NAME}/${stateMachineName}`,
        /**
         * A warning, matching the BBB tier. Licence enrichment going stale degrades lead
         * quality; it does not break the pipeline, and the parcel and permit tiers are the
         * ones that justify waking someone. The previous run's `current.json` stays valid and
         * the next weekly run retries from scratch.
         */
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

    return new sfn.StateMachine(this, 'LicenceHarvestStateMachine', {
      stateMachineName,
      comment: `${SERVICE_NAME} DBPR contractor licence harvest`,
      definitionBody: sfn.DefinitionBody.fromChainable(
        guarded.next(new sfn.Succeed(this, 'LicenceHarvestComplete')),
      ),
      /**
       * An hour, which is the outer bound behind the Lambda's own 15 minutes plus the two
       * state-machine retries and their backoff. A cold run is ~5 minutes.
       */
      timeout: cdk.Duration.hours(1),
      tracingEnabled: true,
      logs: {
        destination: new logs.LogGroup(this, 'LicenceHarvestLogs', {
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
 * That file is being edited by other agents in this repo right now, so adding a line to it
 * would create a conflict for no benefit. Registering this stack is one statement:
 *
 *   new LicenceStack(app, `${stackPrefix}-Licences`, {
 *     description: 'Oracle Seminole DBPR contractor-licence harvest',
 *     env: { account, region },
 *     tags,
 *     targetEnv,
 *     alertNotifier: core.alertNotifier.handler,
 *     dataBucket: core.dataBucket,
 *     // On in dev too: this is the environment reviewers exercise, so the weekly refresh
 *     // should actually be running rather than merely defined.
 *     scheduleEnabled: true,
 *   });
 *
 * plus the import:
 *
 *   import { LicenceStack } from '../lib/licence-stack';
 */
