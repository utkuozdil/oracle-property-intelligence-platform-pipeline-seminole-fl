/**
 * Identity of this service across every observability and cost-attribution surface.
 *
 * `SERVICE_NAME` is deliberately reused verbatim as:
 *   - the Powertools `serviceName` (which becomes the `service` metric dimension)
 *   - the `POWERTOOLS_SERVICE_NAME` Lambda environment variable
 *   - the `project_name` cost-allocation tag on every CDK resource, in both the
 *     TypeScript CDK app and the Python CDK app that owns the Glue tier
 *
 * Keeping those in sync is what makes `CostPredicted` joinable against the AWS Cost
 * Explorer breakdown for the same `project_name`.
 */
export const SERVICE_NAME = 'oracle-seminole';

/** CloudWatch custom-metric namespace. PascalCase form of {@link SERVICE_NAME}. */
export const METRICS_NAMESPACE = 'OracleSeminole';

export const AWS_REGION = 'us-east-2';

/** Default county for ingestion and demos. */
export const COUNTY = 'Seminole County, FL';

export type TargetEnv = 'dev' | 'prod';

export function parseTargetEnv(value: string | undefined): TargetEnv {
  return value === 'prod' ? 'prod' : 'dev';
}

/**
 * Physical name of the single operations topic that every DLQ alarm and every terminal
 * pipeline failure fans out to.
 *
 * It is named rather than referenced so any stack — including the Python CDK app that
 * owns the Glue tier — can derive the ARN locally. That keeps the topic out of
 * CloudFormation's cross-stack exports, which otherwise couple the stacks' deploy order
 * and block the producer from ever changing the topic.
 *
 * Mirrored by `operations_topic_name` in `pipeline/src/oracle_pipeline_infra/constants.py`.
 */
export function operationsTopicName(targetEnv: TargetEnv): string {
  return `${SERVICE_NAME}-${targetEnv}-operations`;
}

/**
 * SSM parameter paths. These are the seam between the two CDK apps: the TypeScript app
 * owns the shared resources and publishes their identifiers here, and the Python CDK
 * app that owns the Glue tier reads them at deploy time.
 */
export function ssmParameterNames(targetEnv: TargetEnv) {
  const prefix = `/${SERVICE_NAME}/${targetEnv}`;
  return {
    dataBucketName: `${prefix}/data-bucket-name`,
    operationsTopicArn: `${prefix}/operations-topic-arn`,
    tableName: `${prefix}/table-name`,
  } as const;
}
