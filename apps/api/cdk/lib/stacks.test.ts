import { SERVICE_NAME } from '@oracle-seminole/shared';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';
import { ApiStack } from './api-stack';
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
});
