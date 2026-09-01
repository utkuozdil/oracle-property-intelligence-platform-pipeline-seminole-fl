import { SERVICE_NAME, parseTargetEnv } from '@oracle-seminole/shared';
import * as cdk from 'aws-cdk-lib';
import { ApiStack } from '../lib/api-stack';
import { BbbStack } from '../lib/bbb-stack';
import { CoreStack } from '../lib/core-stack';
import { LicenceStack } from '../lib/licence-stack';
import { PermitStack } from '../lib/permit-stack';
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
  phase: 'phase-1',
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
  dataBucket: core.dataBucket,
  table: core.table,
});

new PermitStack(app, `${stackPrefix}-Permits`, {
  description: 'Oracle Seminole permit harvest (Source A census + Source B status)',
  env: { account, region },
  tags,
  targetEnv,
  alertNotifier: core.alertNotifier.handler,
  dataBucket: core.dataBucket,
  table: core.table,
});

new BbbStack(app, `${stackPrefix}-Bbb`, {
  description: 'Oracle Seminole BBB contractor-reputation harvest',
  env: { account, region },
  tags,
  targetEnv,
  alertNotifier: core.alertNotifier.handler,
  dataBucket: core.dataBucket,
  // On in dev too: this is the environment reviewers exercise, so the monthly refresh
  // should actually be running rather than merely defined. One Lambda run a month.
  scheduleEnabled: true,
});

new LicenceStack(app, `${stackPrefix}-Licences`, {
  description: 'Oracle Seminole DBPR contractor-licence harvest',
  env: { account, region },
  tags,
  targetEnv,
  alertNotifier: core.alertNotifier.handler,
  dataBucket: core.dataBucket,
  // Weekly on Wednesday, timed after the source regenerates at ~10:48 UTC so a run cannot
  // fetch the previous day's file, and clear of the nightly roll, BBB, and the Sunday permits.
  scheduleEnabled: true,
});

new WebStack(app, `${stackPrefix}-Web`, {
  description: 'Oracle Seminole UI on S3 + CloudFront, also fronting the tRPC API',
  env: { account, region },
  tags,
  targetEnv,
  siteDistPath: '../web/dist',
  apiOriginDomain: `${api.httpApi.apiId}.execute-api.${region}.amazonaws.com`,
});
