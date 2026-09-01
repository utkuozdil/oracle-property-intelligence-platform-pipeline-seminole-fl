import { METRICS_NAMESPACE, SERVICE_NAME, type TargetEnv } from '@oracle-seminole/shared';
import * as cdk from 'aws-cdk-lib';
import * as ecrAssets from 'aws-cdk-lib/aws-ecr-assets';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import { buildSync } from 'esbuild';
import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Construct } from 'constructs';

export interface PlacesStackProps extends cdk.StackProps {
  targetEnv: TargetEnv;
  /** Async-invoked notifier that owns the PagerDuty routing key. */
  alertNotifier: lambda.IFunction;
  dataBucket: s3.IBucket;
  /** Quarterly refresh, matching Overture's publication cadence. Off outside prod. */
  scheduleEnabled?: boolean;
}

const PLACES_SRC = 'src/places';

/**
 * Overture Maps business-places ingest, on a schedule.
 *
 * Shaped like `BbbStack` — one Lambda behind a one-task state machine — for the same reason:
 * the work is a single sequential run whose wall clock is set by something other than
 * parallelism. Here that something is one scan of one Overture theme. Sharding it would have
 * several workers re-reading the same Parquet footers to produce partial counts that then
 * have to be reassembled, and the county clip is a single geometric predicate over 31,000
 * pruned rows, which is not work worth distributing.
 *
 * The one place it departs from the BBB shape is packaging. `src/places/duckdb.ts` invokes
 * the DuckDB command-line binary through `execFileSync`, so the runtime must contain that
 * binary plus its `httpfs` and `spatial` extensions — which a zipped Lambda cannot carry.
 * This is therefore a `DockerImageFunction` over `src/places/Dockerfile`, which bakes both in
 * at build time so nothing is downloaded on the invocation path.
 */
export class PlacesStack extends cdk.Stack {
  readonly stateMachine: sfn.StateMachine;

  constructor(scope: Construct, id: string, props: PlacesStackProps) {
    super(scope, id, props);

    const ingestPlaces = this.buildFunction(props);
    /**
     * Read for the peer join, write for the artifacts. The read half is load-bearing: the
     * roofing join reaches the permit census under `staged/permits/` and the BBB harvest
     * under `staged/bbb/`, and without it both hops would report a confident zero rather
     * than fail.
     */
    props.dataBucket.grantReadWrite(ingestPlaces);

    this.stateMachine = this.buildStateMachine({
      alertNotifier: props.alertNotifier,
      ingestPlaces,
    });

    /**
     * Quarterly, because Overture publishes roughly every three months and its bucket
     * retains only the two most recent releases. A monthly schedule would re-extract a
     * release that had not changed; an annual one would let the pinned release fall out of
     * retention, taking the release-over-release diff with it.
     *
     * The pin in `config.ts` still moves by commit. This schedule refreshes the artifact and
     * reports drift against the STAC catalog; it never follows drift silently.
     */
    new events.Rule(this, 'PlacesIngestSchedule', {
      description: `${SERVICE_NAME} quarterly Overture business-places ingest`,
      schedule: events.Schedule.cron({ minute: '0', hour: '8', day: '2', month: '1,4,7,10' }),
      // On outside prod too. Dev is the environment reviewers exercise, and a rule that
      // never fires is indistinguishable from no rule. Four runs a year at ~$0.003 each.
      enabled: props.scheduleEnabled ?? true,
      targets: [
        new targets.SfnStateMachine(this.stateMachine, {
          input: events.RuleTargetInput.fromObject({}),
        }),
      ],
    });

    new cdk.CfnOutput(this, 'PlacesIngestStateMachineArn', {
      value: this.stateMachine.stateMachineArn,
    });
    new cdk.CfnOutput(this, 'PlacesIngestFunctionName', {
      value: ingestPlaces.functionName,
    });
  }

  /**
   * The image asset, and the esbuild step that feeds it.
   *
   * The handler is bundled here rather than inside the Dockerfile so the build context stays
   * two files. Bundling in the image would mean shipping the pnpm workspace into Docker and
   * resolving `@oracle-seminole/shared` from a symlinked store, which is both slow and a
   * different resolution than every other function in this repository gets.
   */
  private buildFunction(props: PlacesStackProps): lambda.DockerImageFunction {
    const context = mkdtempSync(join(tmpdir(), 'oracle-places-image-'));
    buildSync({
      entryPoints: [join(PLACES_SRC, 'handler.ts')],
      outfile: join(context, 'index.js'),
      bundle: true,
      platform: 'node',
      target: 'node22',
      format: 'cjs',
      minify: true,
      sourcemap: true,
      // Matches `ObservableFunction`: source-mapped stack traces are the only way a failure
      // inside a minified bundle names a line in this repository.
      banner: { js: "process.env.NODE_OPTIONS ??= '--enable-source-maps';" },
    });
    copyFileSync(join(PLACES_SRC, 'Dockerfile'), join(context, 'Dockerfile'));

    return new lambda.DockerImageFunction(this, 'IngestPlaces', {
      description: `${SERVICE_NAME} Overture business-places ingest`,
      code: lambda.DockerImageCode.fromImageAsset(context, {
        /**
         * Pinned to x86_64 for two reasons: the DuckDB CLI asset the image pulls is
         * `linux-amd64`, and the `CostPredicted` metric is backed by `us-east-2` x86 price
         * constants. Left implicit, an arm64 developer machine would build an image the
         * function cannot execute.
         */
        platform: ecrAssets.Platform.LINUX_AMD64,
      }),
      architecture: lambda.Architecture.X86_64,
      /**
       * A deployed run reported `Max Memory Used: 1080 MB`, and that figure covers both
       * processes: Node holding the peer census while the DuckDB CLI runs beside it with its
       * own working set. 4 GB is roughly four times it.
       *
       * The headroom is not padding, it is vCPU. Lambda allocates cores in proportion to
       * memory, and the extract is a scan of a whole Overture theme over HTTP that DuckDB
       * runs multi-threaded, going single-threaded only for the deterministic write. At this
       * size the deployed extract finished in 25.7 s against 44.4 s on a developer laptop.
       * Halving the memory would roughly halve the cores and lengthen the run by about as
       * much as it saved, so the cheaper-looking setting costs the same and takes longer.
       */
      memorySize: 4096,
      /**
       * `/tmp` holds the whole working tree, and the DuckDB database dominates it rather
       * than the artifacts: a measured run leaves 32 MB, of which 23 MB is the database and
       * 6.8 MB is everything that then goes to the bucket. A `--diff` run materialises a
       * second release's tables alongside the first, and anything DuckDB spills lands here
       * too because there is nowhere else writable.
       *
       * 2 GB is far more than that, deliberately. Ephemeral storage above the free 512 MB
       * costs about three millionths of a dollar for a run of this length, which makes
       * over-provisioning free and a quarterly job dying on a full disk expensive.
       */
      ephemeralStorageSize: cdk.Size.mebibytes(2048),
      /**
       * Fifteen minutes against a measured 39 s, extract included. The headroom is not for
       * the extract — it is for the peer read, which is no longer the handful of fixtures it
       * was when this join was first measured: the staged permit census reached 487 shards
       * during the writing of this stack and is still growing as the backfill lands.
       */
      timeout: cdk.Duration.minutes(15),
      environment: {
        DATA_BUCKET: props.dataBucket.bucketName,
        POWERTOOLS_SERVICE_NAME: SERVICE_NAME,
        POWERTOOLS_METRICS_NAMESPACE: METRICS_NAMESPACE,
        POWERTOOLS_LOG_LEVEL: props.targetEnv === 'prod' ? 'INFO' : 'DEBUG',
        POWERTOOLS_LOGGER_LOG_EVENT: String(props.targetEnv !== 'prod'),
        TARGET_ENV: props.targetEnv,
      },
      tracing: lambda.Tracing.ACTIVE,
      /**
       * One instance, ever. Every artifact key is derived from the release rather than the
       * run, so two concurrent runs would write the same objects and the pointer could end
       * up naming a table the other run was still uploading.
       */
      reservedConcurrentExecutions: 1,
      logGroup: new logs.LogGroup(this, 'IngestPlacesLogs', {
        logGroupName: `/aws/lambda/${SERVICE_NAME}-${props.targetEnv}-IngestPlaces`,
        retention: logs.RetentionDays.THREE_MONTHS,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });
  }

  private buildStateMachine(options: {
    ingestPlaces: lambda.IFunction;
    alertNotifier: lambda.IFunction;
  }): sfn.StateMachine {
    const stateMachineName = 'SeminolePlacesIngest';
    const runId = sfn.JsonPath.stringAt('$$.Execution.Name');

    const ingestTask = new tasks.LambdaInvoke(this, 'IngestPlacesTask', {
      lambdaFunction: options.ingestPlaces,
      payload: sfn.TaskInput.fromObject({
        runId,
        // Passed whole and defaulted in the handler, because `{}` is what a schedule sends.
        request: sfn.JsonPath.objectAt('$$.Execution.Input'),
      }),
      resultPath: '$.places',
      payloadResponseOnly: true,
    });
    ingestTask.addRetry({
      errors: [
        'Lambda.ServiceException',
        'Lambda.AWSLambdaException',
        'Lambda.SdkClientException',
        'Lambda.TooManyRequestsException',
      ],
      interval: cdk.Duration.seconds(30),
      maxAttempts: 2,
      backoffRate: 2,
    });
    /**
     * `SourceGateError` is deliberately absent from that list. An unapproved or forbidden
     * provider in the extract is a licence problem, and retrying it would only reach the
     * same verdict twice while delaying the page that should follow it.
     */

    const guarded = new sfn.Parallel(this, 'PlacesIngestBody', {
      comment: 'Single-branch wrapper that gives the whole workflow one top-level Catch',
      outputPath: '$[0]',
    });
    guarded.branch(ingestTask);

    const failure = new sfn.Fail(this, 'PlacesIngestFailed', {
      comment: 'Terminal failure, reached only after on-call has been paged',
    });

    const pageOnCall = new tasks.LambdaInvoke(this, 'PlacesIngestPageOnCall', {
      lambdaFunction: options.alertNotifier,
      payload: sfn.TaskInput.fromObject({
        summary: sfn.JsonPath.format(
          `${stateMachineName} failed: {}`,
          sfn.JsonPath.stringAt('$.error.Cause'),
        ),
        source: `${SERVICE_NAME}/${stateMachineName}`,
        /**
         * A warning, like BBB and unlike the parcel tier. The published artifact from the
         * previous release stays valid and readable until this succeeds, and the schedule is
         * quarterly — there is nothing about a failed run here that is better handled at
         * 3am than the next morning.
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

    return new sfn.StateMachine(this, 'PlacesIngestStateMachine', {
      stateMachineName,
      comment: `${SERVICE_NAME} Overture business-places ingest`,
      definitionBody: sfn.DefinitionBody.fromChainable(
        guarded.next(new sfn.Succeed(this, 'PlacesIngestComplete')),
      ),
      // The outer bound behind the Lambda's own timeout, with room for its two retries.
      timeout: cdk.Duration.hours(1),
      tracingEnabled: true,
      logs: {
        destination: new logs.LogGroup(this, 'PlacesIngestLogs', {
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
 * `app.ts` is being edited by another agent in this repo right now, so adding it there would
 * create a conflict. Registering it is one statement:
 *
 *   new PlacesStack(app, `${stackPrefix}-Places`, {
 *     description: 'Oracle Seminole Overture business-places ingest',
 *     env: { account, region },
 *     tags,
 *     targetEnv,
 *     alertNotifier: core.alertNotifier.handler,
 *     dataBucket: core.dataBucket,
 *   });
 */
