import { SERVICE_NAME, parseTargetEnv } from '@oracle-seminole/shared';
import * as cdk from 'aws-cdk-lib';
import { ApiStack } from '../lib/api-stack';
import { CoreStack } from '../lib/core-stack';
import { PipelineStack } from '../lib/pipeline-stack';
import { WebStack } from '../lib/web-stack';

const app = new cdk.App();

const targetEnv = parseTargetEnv(process.env.TARGET_ENV ?? app.node.tryGetContext('targetEnv'));
const region = 'us-east-2';
const account = process.env.CDK_DEFAULT_ACCOUNT;
const stackPrefix = `OracleSeminole-${targetEnv}`;

/**
 * Cost-allocation tags applied at stack scope so every taggable resource inherits them.
 * `project_name` matches the `service` dimension carried by `CostPredicted`, which is
 * what makes predicted and billed cost comparable for the same key. The Python CDK app
 * that owns the Glue tier applies the identical tag set.
 */
const tags: Record<string, string> = {
  project_name: SERVICE_NAME,
  environment: targetEnv,
  managed_by: 'cdk',
  phase: 'phase-0',
};

const core = new CoreStack(app, `${stackPrefix}-Core`, {
  description:
    'Oracle Seminole stateful core: single table, data-lake bucket, operations topic, PagerDuty alerting',
  env: { account, region },
  tags,
  targetEnv,
});

const api = new ApiStack(app, `${stackPrefix}-Api`, {
  description: 'Oracle Seminole tRPC Lambda behind an API Gateway HTTP API',
  env: { account, region },
  tags,
  targetEnv,
  table: core.table,
  dataBucket: core.dataBucket,
});

new PipelineStack(app, `${stackPrefix}-Pipeline`, {
  description: 'Oracle Seminole Step Functions orchestration and its worker Lambdas',
  env: { account, region },
  tags,
  targetEnv,
  alertNotifier: core.alertNotifier.handler,
});

new WebStack(app, `${stackPrefix}-Web`, {
  description: 'Oracle Seminole UI on S3 + CloudFront, also fronting the tRPC API',
  env: { account, region },
  tags,
  targetEnv,
  siteDistPath: '../web/dist',
  apiOriginDomain: `${api.httpApi.apiId}.execute-api.${region}.amazonaws.com`,
});
