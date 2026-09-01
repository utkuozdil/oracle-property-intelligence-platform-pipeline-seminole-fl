/**
 * A standalone CDK app for `PlacesStack`, and nothing else.
 *
 * `cdk/bin/app.ts` is the real entry point and this stack belongs in it, wired to
 * `core.dataBucket` and `core.alertNotifier.handler` like every other tier. It is not there
 * yet only because that file is being edited concurrently; the registration statement is
 * quoted at the bottom of `cdk/lib/places-stack.ts`.
 *
 * This exists so the stack could be deployed and *run* before that lands, because a stack
 * that has only ever synthesised is not evidence of anything.
 *
 * It resolves the two core resources by literal name rather than by constructing `CoreStack`.
 * That is the whole point of the file: instantiating `CoreStack` here would make CDK emit
 * cross-stack exports the deployed Core stack does not have, and `--exclusively` would then
 * refuse to deploy. Literals rather than SSM tokens for the same reason — a token owned by
 * another stack is a cross-stack reference however it is spelled.
 *
 * Neither literal is committed. Both are supplied at deploy time:
 *
 *   npx cdk --app "pnpm exec tsx cdk/bin/places-app.ts" \
 *     deploy "OracleSeminole-dev-Places" --exclusively --require-approval never \
 *     --output /tmp/cdk.places \
 *     -c dataBucketName=$(aws ssm get-parameter --name /oracle-seminole/dev/data-bucket-name \
 *          --query Parameter.Value --output text) \
 *     -c alertNotifierArn=<arn>
 *
 * Delete this file once `PlacesStack` is registered in `app.ts`.
 */
import { SERVICE_NAME, parseTargetEnv } from '@oracle-seminole/shared';
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { PlacesStack } from '../lib/places-stack';

const app = new cdk.App();

const targetEnv = parseTargetEnv(process.env.TARGET_ENV ?? app.node.tryGetContext('targetEnv'));
const region = 'us-east-2';
const account = process.env.CDK_DEFAULT_ACCOUNT;
const stackPrefix = `OracleSeminole-${targetEnv}`;

function required(name: string, fallback?: string): string {
  const value = fallback ?? (app.node.tryGetContext(name) as string | undefined);
  if (!value) throw new Error(`supply -c ${name}=<value>`);
  return value;
}

const dataBucketName = required('dataBucketName', process.env.DATA_BUCKET);
const alertNotifierArn = required('alertNotifierArn', process.env.ALERT_NOTIFIER_ARN);

/** Identical to the set `app.ts` applies, so a stack deployed either way is tagged the same. */
const tags: Record<string, string> = {
  project_name: SERVICE_NAME,
  environment: targetEnv,
  managed_by: 'cdk',
  phase: 'phase-1',
};

/**
 * A scope for the two imported references. It holds no resources and is never deployed; the
 * imports need a stack to hang off, and hanging them off `PlacesStack` is impossible because
 * they are its constructor arguments.
 */
const refs = new cdk.Stack(app, `${stackPrefix}-PlacesRefs`, { env: { account, region } });

new PlacesStack(app, `${stackPrefix}-Places`, {
  description: 'Oracle Seminole Overture business-places ingest',
  env: { account, region },
  tags,
  targetEnv,
  dataBucket: s3.Bucket.fromBucketName(refs, 'DataBucket', dataBucketName),
  alertNotifier: lambda.Function.fromFunctionArn(refs, 'AlertNotifier', alertNotifierArn),
});
