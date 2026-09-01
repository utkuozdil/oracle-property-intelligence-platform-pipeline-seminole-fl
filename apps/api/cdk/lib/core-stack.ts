import {
  DATA_PREFIXES,
  METRICS_NAMESPACE,
  RAW_ARCHIVE_PREFIX,
  RAW_EXPANDED_PREFIX,
  operationsTopicName,
  SERVICE_NAME,
  ssmParameterNames,
  type TargetEnv,
} from '@oracle-seminole/shared';
import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';
import { AsyncObservableFunction } from './constructs/async-observable-function';

export interface CoreStackProps extends cdk.StackProps {
  targetEnv: TargetEnv;
}

/**
 * Stateful and cross-cutting resources shared by the serving tier, the pipeline tier,
 * and the Python Glue tier: the single DynamoDB table, the data-lake bucket, the one
 * operations topic every alarm fans out through, the PagerDuty routing-key secret, and
 * the alert notifier that every critical failure path routes to.
 *
 * Identifiers are also published to SSM Parameter Store. That is the seam the separate
 * Python CDK app reads at deploy time, so the two CDK apps stay decoupled without
 * either one hardcoding a physical name.
 */
export class CoreStack extends cdk.Stack {
  readonly table: dynamodb.TableV2;
  readonly dataBucket: s3.Bucket;
  readonly operationsTopic: sns.Topic;
  readonly pagerDutySecret: secretsmanager.Secret;
  readonly alertNotifier: AsyncObservableFunction;

  constructor(scope: Construct, id: string, props: CoreStackProps) {
    super(scope, id, props);

    this.table = new dynamodb.TableV2(this, 'Table', {
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.dataBucket = new s3.Bucket(this, 'DataBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: false,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [
        {
          /**
           * The CSVs expanded out of each nightly archive.
           *
           * 640 MB per run against the 95 MB archive they came from, and entirely
           * reproducible from it — the Glue job re-expands the archive on every run
           * regardless. Keeping them is paying seven times over to store a cache.
           *
           * Seven days rather than one: long enough to debug a bad run against the exact
           * CSVs it read, which is the only reason to want them at all, and short enough
           * that a month of nightlies cannot accumulate 19 GB.
           *
           * Deliberately scoped away from `raw/archive/`, which holds the provenance
           * record, and from `manifests/`, which is the run history.
           */
          id: 'ExpireExpandedCsvs',
          enabled: true,
          prefix: RAW_EXPANDED_PREFIX,
          expiration: cdk.Duration.days(7),
        },
        {
          /**
           * The nightly CAMA archives themselves.
           *
           * These are the provenance record — the exact bytes the county served — and
           * nothing expired them, so they accumulated at ~95 MB a night: ~34 GB and
           * ~$0.80/month after a year, growing without bound.
           *
           * 180 days rather than 7, because unlike the expanded CSVs these are not
           * derivable from anything. Half a year keeps every archive behind the last two
           * quarterly reviews, which is the window in which anyone actually re-reads one:
           * to prove what a published snapshot was built from, or to re-run a transform
           * change against a specific night's bytes. Past that, the run manifest's
           * `sourceFingerprint` still records the archive's SHA-256, so provenance
           * survives the archive.
           *
           * Scoped to `raw/archive/` alone. `raw/expanded/` has its own 7-day rule above,
           * and `raw/fdor/` must never be reached by either — the FDOR snapshot is
           * republished annually and a 180-day expiry would delete the live second source
           * six months before its replacement exists.
           */
          id: 'ExpireRawArchives',
          enabled: true,
          prefix: RAW_ARCHIVE_PREFIX,
          expiration: cdk.Duration.days(180),
        },
        {
          /**
           * The archive upload is multipart, so an interrupted acquire leaves parts that
           * are billed but invisible to a listing. Nothing else reclaims them.
           */
          id: 'AbortIncompleteUploads',
          enabled: true,
          abortIncompleteMultipartUploadAfter: cdk.Duration.days(1),
        },
      ],
    });

    /**
     * S3 has no real directories, so the four prefixes are materialised as empty marker
     * objects. That makes the layout visible in the console and lets the readiness probe
     * confirm each prefix is listable before any ingestion has run.
     */
    new s3deploy.BucketDeployment(this, 'DataLayout', {
      destinationBucket: this.dataBucket,
      sources: Object.values(DATA_PREFIXES).map((prefix) =>
        s3deploy.Source.data(`${prefix}.keep`, ''),
      ),
      prune: false,
    });

    this.operationsTopic = new sns.Topic(this, 'OperationsTopic', {
      topicName: operationsTopicName(props.targetEnv),
      displayName: `${SERVICE_NAME} operations alerts`,
    });

    /**
     * The Python CDK app routes terminal Glue job states here through EventBridge. That
     * app imports the topic by ARN and therefore cannot amend its resource policy, so the
     * publish grant is declared by the topic's owner instead.
     */
    this.operationsTopic.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowEventBridgePublish',
        principals: [new iam.ServicePrincipal('events.amazonaws.com')],
        actions: ['sns:Publish'],
        resources: [this.operationsTopic.topicArn],
        conditions: { StringEquals: { 'aws:SourceAccount': cdk.Stack.of(this).account } },
      }),
    );

    /**
     * Stub secret. The value is generated by Secrets Manager rather than written into
     * the template, so no routing key — real or placeholder — is ever committed. An
     * operator replaces `routingKey` with the real PagerDuty integration key.
     */
    this.pagerDutySecret = new secretsmanager.Secret(this, 'PagerDutyRoutingKey', {
      // Named so the operator who has to paste the real key in can find it, and so the
      // IAM grant that scopes the notifier to this one ARN is auditable by eye.
      secretName: `${SERVICE_NAME}/${props.targetEnv}/pagerduty-routing-key`,
      description: `PagerDuty Events API v2 routing key for ${SERVICE_NAME}`,
      generateSecretString: {
        secretStringTemplate: JSON.stringify({}),
        generateStringKey: 'routingKey',
        excludePunctuation: true,
        passwordLength: 32,
      },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.alertNotifier = new AsyncObservableFunction(this, 'AlertNotifier', {
      entry: 'src/pagerduty/notifier.ts',
      description: `${SERVICE_NAME} PagerDuty alert notifier`,
      serviceName: SERVICE_NAME,
      metricsNamespace: METRICS_NAMESPACE,
      targetEnv: props.targetEnv,
      alarmTopic: this.operationsTopic,
      alarmName: `${SERVICE_NAME}-${props.targetEnv}-alert-notifier-dlq-not-empty`,
      memorySize: 256,
      timeout: cdk.Duration.seconds(15),
      environment: {
        PAGERDUTY_SECRET_ARN: this.pagerDutySecret.secretArn,
        PAGERDUTY_ENABLED: String(props.targetEnv === 'prod'),
      },
    });

    this.pagerDutySecret.grantRead(this.alertNotifier.handler);

    const parameters = ssmParameterNames(props.targetEnv);
    new ssm.StringParameter(this, 'DataBucketNameParameter', {
      parameterName: parameters.dataBucketName,
      stringValue: this.dataBucket.bucketName,
      description: 'Consumed by the Python CDK app that owns the Glue tier',
    });
    new ssm.StringParameter(this, 'OperationsTopicArnParameter', {
      parameterName: parameters.operationsTopicArn,
      stringValue: this.operationsTopic.topicArn,
      description: 'Consumed by the Python CDK app that owns the Glue tier',
    });
    new ssm.StringParameter(this, 'TableNameParameter', {
      parameterName: parameters.tableName,
      stringValue: this.table.tableName,
      description: 'Consumed by the Python CDK app that owns the Glue tier',
    });

    new cdk.CfnOutput(this, 'TableName', { value: this.table.tableName });
    new cdk.CfnOutput(this, 'DataBucketName', { value: this.dataBucket.bucketName });
    new cdk.CfnOutput(this, 'OperationsTopicArn', { value: this.operationsTopic.topicArn });
    new cdk.CfnOutput(this, 'PagerDutySecretArn', { value: this.pagerDutySecret.secretArn });
  }
}
