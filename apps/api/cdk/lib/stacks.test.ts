import { SERVICE_NAME } from '@oracle-seminole/shared';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';
import { ApiStack, NLQ_MODEL_ID } from './api-stack';
import { CoreStack } from './core-stack';
import { PipelineStack } from './pipeline-stack';

const env = { account: '795366345505', region: 'us-east-2' };
const tags = { project_name: SERVICE_NAME, environment: 'dev' };

let coreTemplate: Template;
let apiTemplate: Template;
let pipelineTemplate: Template;

beforeAll(() => {
  const app = new cdk.App();
  const core = new CoreStack(app, 'TestCore', { env, tags, targetEnv: 'dev' });
  const api = new ApiStack(app, 'TestApi', {
    env,
    tags,
    targetEnv: 'dev',
    table: core.table,
    dataBucket: core.dataBucket,
  });
  const pipeline = new PipelineStack(app, 'TestPipeline', {
    env,
    tags,
    targetEnv: 'dev',
    alertNotifier: core.alertNotifier.handler,
    dataBucket: core.dataBucket,
    table: core.table,
  });
  coreTemplate = Template.fromStack(core);
  apiTemplate = Template.fromStack(api);
  pipelineTemplate = Template.fromStack(pipeline);
});

function applicationFunctions(template: Template) {
  return Object.values(template.findResources('AWS::Lambda::Function')).filter(
    (fn) => fn.Properties?.Environment?.Variables?.POWERTOOLS_SERVICE_NAME !== undefined,
  );
}

describe('every Lambda carries the observability contract', () => {
  it('enables X-Ray active tracing, source maps, and Powertools variables', () => {
    for (const template of [coreTemplate, apiTemplate, pipelineTemplate]) {
      const functions = applicationFunctions(template);
      expect(functions.length).toBeGreaterThan(0);
      for (const fn of functions) {
        expect(fn.Properties.TracingConfig).toEqual({ Mode: 'Active' });
        expect(fn.Properties.Environment.Variables.NODE_OPTIONS).toBe('--enable-source-maps');
        expect(fn.Properties.Environment.Variables.POWERTOOLS_SERVICE_NAME).toBe(SERVICE_NAME);
        expect(fn.Properties.Environment.Variables.POWERTOOLS_METRICS_NAMESPACE).toBe(
          'OracleSeminole',
        );
      }
    }
  });

  it('gives every log group a distinct conventional name', () => {
    const names = [coreTemplate, apiTemplate, pipelineTemplate].flatMap((template) =>
      Object.values(template.findResources('AWS::Logs::LogGroup')).map(
        (group) => group.Properties.LogGroupName as string,
      ),
    );
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(name).toMatch(
        new RegExp(`^(/aws/lambda/${SERVICE_NAME}-dev-|/aws/vendedlogs/states/)`),
      );
    }
    // The alert notifier and the permit-harvest worker both name their inner function
    // `Function`, so an id-only log-group name would collide and fail the deploy.
    expect(new Set(names).size).toBe(names.length);
  });

  it('retains every log group for 90 days', () => {
    for (const template of [coreTemplate, apiTemplate, pipelineTemplate]) {
      for (const group of Object.values(template.findResources('AWS::Logs::LogGroup'))) {
        expect(group.Properties.RetentionInDays).toBe(90);
      }
    }
  });
});

describe('the data-lake bucket', () => {
  it('is private, encrypted, and materialises the four Phase 0 prefixes', () => {
    coreTemplate.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      BucketEncryption: Match.objectLike({ ServerSideEncryptionConfiguration: Match.anyValue() }),
    });
    coreTemplate.resourceCountIs('Custom::CDKBucketDeployment', 1);
  });

  it('expires the derivable CSVs weekly and the provenance archives after 180 days', () => {
    coreTemplate.hasResourceProperties('AWS::S3::Bucket', {
      LifecycleConfiguration: {
        Rules: Match.arrayWith([
          Match.objectLike({
            Id: 'ExpireExpandedCsvs',
            Status: 'Enabled',
            Prefix: 'raw/expanded/',
            ExpirationInDays: 7,
          }),
          Match.objectLike({
            Id: 'ExpireRawArchives',
            Status: 'Enabled',
            Prefix: 'raw/archive/',
            ExpirationInDays: 180,
          }),
          Match.objectLike({
            Id: 'AbortIncompleteUploads',
            Status: 'Enabled',
            AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
          }),
        ]),
      },
    });
  });

  it('never expires the FDOR snapshot, which is republished only once a year', () => {
    const bucket = Object.values(coreTemplate.findResources('AWS::S3::Bucket')).find(
      (candidate) => candidate.Properties?.LifecycleConfiguration !== undefined,
    );
    const rules = bucket?.Properties.LifecycleConfiguration.Rules as { Prefix?: string }[];

    // An expiry that reached `raw/fdor/` would delete the live second source months
    // before its replacement is published. Every prefixed rule must be strictly narrower.
    for (const rule of rules) {
      if (rule.Prefix === undefined) continue;
      expect('raw/fdor/'.startsWith(rule.Prefix)).toBe(false);
    }
  });
});

describe('dead-letter queues', () => {
  it('gives the async notifier an SQS DLQ', () => {
    coreTemplate.hasResourceProperties('AWS::Lambda::Function', {
      DeadLetterConfig: { TargetArn: Match.anyValue() },
    });
  });

  it('gives the queue-driven permit worker a redrive policy to its own DLQ', () => {
    pipelineTemplate.hasResourceProperties('AWS::SQS::Queue', {
      RedrivePolicy: Match.objectLike({ maxReceiveCount: 3 }),
    });
    pipelineTemplate.resourceCountIs('AWS::SQS::Queue', 2);
  });

  it('carries exactly one self-resolving alarm per dead-letter queue', () => {
    for (const [template, expected] of [
      [coreTemplate, 1],
      [pipelineTemplate, 1],
    ] as const) {
      template.resourceCountIs('AWS::CloudWatch::Alarm', expected);
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        MetricName: 'ApproximateNumberOfMessagesVisible',
        Namespace: 'AWS/SQS',
        Statistic: 'Maximum',
        Threshold: 0,
        ComparisonOperator: 'GreaterThanThreshold',
        EvaluationPeriods: 1,
        DatapointsToAlarm: 1,
        TreatMissingData: 'notBreaching',
      });

      const alarm = Object.values(template.findResources('AWS::CloudWatch::Alarm'))[0];
      expect(alarm?.Properties.AlarmActions).toEqual(alarm?.Properties.OKActions);
    }
  });
});

describe('PagerDuty routing key', () => {
  it('is generated by Secrets Manager rather than written into the template', () => {
    coreTemplate.hasResourceProperties('AWS::SecretsManager::Secret', {
      GenerateSecretString: Match.objectLike({ GenerateStringKey: 'routingKey' }),
    });

    const secrets = Object.values(coreTemplate.findResources('AWS::SecretsManager::Secret'));
    expect(secrets).toHaveLength(1);
    expect(secrets[0]?.Properties.SecretString).toBeUndefined();
  });

  it('grants the notifier read access scoped to that one secret ARN', () => {
    coreTemplate.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(['secretsmanager:GetSecretValue']),
            Resource: { Ref: Match.stringLikeRegexp('PagerDutyRoutingKey') },
          }),
        ]),
      }),
    });
  });
});

describe('the tRPC API', () => {
  it('is fronted by an API Gateway HTTP API, not a Lambda function URL', () => {
    apiTemplate.resourceCountIs('AWS::ApiGatewayV2::Api', 1);
    apiTemplate.resourceCountIs('AWS::Lambda::Url', 0);
    apiTemplate.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: 'ANY /trpc/{proxy+}',
    });
  });

  it('configures the agent model and grants Bedrock invoke', () => {
    apiTemplate.hasResourceProperties('AWS::Lambda::Function', {
      Environment: { Variables: Match.objectLike({ NLQ_MODEL_ID }) },
    });
    apiTemplate.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'bedrock:InvokeModel',
            Resource: Match.arrayWith([Match.stringLikeRegexp('foundation-model')]),
          }),
        ]),
      }),
    });
  });

  it('pins the agent to Claude Haiku 4.5', () => {
    expect(NLQ_MODEL_ID).toBe('us.anthropic.claude-haiku-4-5-20251001-v1:0');
  });
});

describe('the state machines', () => {
  it('provisions SeminoleRefresh and PermitHarvest with tracing enabled', () => {
    pipelineTemplate.resourceCountIs('AWS::StepFunctions::StateMachine', 2);
    for (const name of ['SeminoleRefresh', 'PermitHarvest']) {
      pipelineTemplate.hasResourceProperties('AWS::StepFunctions::StateMachine', {
        StateMachineName: name,
        TracingConfiguration: { Enabled: true },
      });
    }
  });

  it('routes each top-level Catch to a PagerDuty trigger before Fail', () => {
    const machines = Object.values(
      pipelineTemplate.findResources('AWS::StepFunctions::StateMachine'),
    );
    expect(machines).toHaveLength(2);

    for (const machine of machines) {
      const definition = JSON.stringify(machine.Properties.DefinitionString);
      const name = machine.Properties.StateMachineName as string;
      expect(definition).toContain(`${name}PageOnCall`);
      expect(definition).toContain(`${name}Failed`);
      // The catch handler must be the page task, never the Fail state directly.
      expect(definition).toContain(`\\"Next\\":\\"${name}PageOnCall\\"`);
    }
  });

  it('uses Standard, not Express, so execution history survives as evidence', () => {
    for (const machine of Object.values(
      pipelineTemplate.findResources('AWS::StepFunctions::StateMachine'),
    )) {
      // CDK omits StateMachineType for Standard, which is the default.
      expect(machine.Properties.StateMachineType).toBeUndefined();
    }
  });
});

function refreshDefinition(): string {
  const machine = Object.values(
    pipelineTemplate.findResources('AWS::StepFunctions::StateMachine'),
  ).find((candidate) => candidate.Properties.StateMachineName === 'SeminoleRefresh');
  return JSON.stringify(machine?.Properties.DefinitionString);
}

describe('the SeminoleRefresh cost gate', () => {
  it('predicts cost as the first state, before any data is touched', () => {
    const definition = refreshDefinition();
    expect(definition).toContain('PredictCostTask');
    // The Parallel wrapper is the entry point; PredictCost is the first state inside it.
    expect(definition).toMatch(/\\"StartAt\\":\\"PredictCostTask\\"/);
  });

  it('pauses on a task token when the estimate exceeds the ceiling', () => {
    const definition = refreshDefinition();
    expect(definition).toContain('OverBudget?');
    expect(definition).toContain('APPROVAL_REQUIRED');
    expect(definition).toContain('AwaitApprovalTask');
    // `.waitForTaskToken` is what makes the pause a pause rather than a notification.
    expect(definition).toContain('waitForTaskToken');
  });

  it('reaches the transform on both the approved and the under-budget path', () => {
    const definition = refreshDefinition();
    expect(definition).toContain('FetchRollTask');
    expect(definition).toContain('SeminoleTransform');
  });
});

describe('the SeminoleRefresh transform step', () => {
  it('invokes the Glue job synchronously so its failure is the step failure', () => {
    const definition = refreshDefinition();
    expect(definition).toContain('glue:startJobRun.sync');
    expect(definition).toContain('oracle-seminole-dev-seminole-refresh');
  });

  it('passes every argument the Glue script requires', () => {
    const definition = refreshDefinition();
    for (const argument of [
      '--data_bucket',
      '--run_id',
      '--source_etag',
      '--source_last_modified',
      '--source_fingerprint',
      '--snapshot_year',
      '--target_env',
    ]) {
      expect(definition).toContain(argument);
    }
  });

  it('skips the transform entirely when the source ETag is unchanged', () => {
    const definition = refreshDefinition();
    expect(definition).toContain('SourceChanged?');
    expect(definition).toContain('RecordSkippedRun');
    expect(definition).toContain('sourceEtag');
  });
});

describe('the FDOR second source', () => {
  it('is acquired on the transform branch, before the Glue job', () => {
    const definition = refreshDefinition();
    expect(definition).toContain('FetchFdorTask');
    expect(definition).toContain(`\\"Next\\":\\"SeminoleTransform\\"`);
  });

  it('survives its own failure rather than stopping the nightly CAMA run', () => {
    // FDOR is republished annually against CAMA's nightly rebuild, so an unreachable
    // service costs snapshot freshness, not the night's parcels. Without this catch a
    // transient ArcGIS failure would page on-call and skip a county refresh.
    const definition = refreshDefinition();
    expect(definition).toContain('FdorUnavailable');
    expect(definition).toContain('\\"Catch\\"');
  });

  it('converges both the caught and the uncaught path on the transform', () => {
    const machine = Object.values(
      pipelineTemplate.findResources('AWS::StepFunctions::StateMachine'),
    ).find((candidate) => candidate.Properties.StateMachineName === 'SeminoleRefresh');
    const definition = JSON.stringify(machine?.Properties.DefinitionString);
    // The Pass must not terminate the branch; a degraded run still transforms.
    expect(definition).toMatch(/FdorUnavailable[\s\S]*?SeminoleTransform/);
  });
});

describe('source acquisition throttling', () => {
  it('caps the fetcher at one concurrent execution', () => {
    const fetchers = Object.values(pipelineTemplate.findResources('AWS::Lambda::Function')).filter(
      (fn) => (fn.Properties?.Description as string)?.includes('archive acquisition'),
    );
    expect(fetchers).toHaveLength(1);
    // One county web server, one request in flight. This is the hard ceiling behind
    // the ETag ledger and the running-twin check.
    expect(fetchers[0]?.Properties.ReservedConcurrentExecutions).toBe(1);
  });
});
