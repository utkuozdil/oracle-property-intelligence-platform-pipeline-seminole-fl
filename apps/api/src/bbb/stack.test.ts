/**
 * The BBB stack's shape.
 *
 * The assertions here are about the properties that keep this tier a polite citizen of a
 * third-party public site — one concurrent worker, no retry on a refusal — rather than about
 * the template's full contents.
 */
import { SERVICE_NAME } from '@oracle-seminole/shared';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';
import { BbbStack } from '../../cdk/lib/bbb-stack';
import { CoreStack } from '../../cdk/lib/core-stack';

describe('BbbStack', () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const env = { account: '795366345505', region: 'us-east-2' };
    const tags = { project_name: SERVICE_NAME, environment: 'dev' };
    const core = new CoreStack(app, 'TestBbbCore', { env, tags, targetEnv: 'dev' });
    const bbb = new BbbStack(app, 'TestBbb', {
      env,
      tags,
      targetEnv: 'dev',
      alertNotifier: core.alertNotifier.handler,
      dataBucket: core.dataBucket,
    });
    template = Template.fromStack(bbb);
  });

  it('pins the harvester to a single concurrent execution', () => {
    // The in-process ~1 req/s pacing is only a real ceiling if one instance can run at a time.
    template.hasResourceProperties('AWS::Lambda::Function', {
      Description: Match.stringLikeRegexp('BBB contractor reputation harvest'),
      ReservedConcurrentExecutions: 1,
    });
  });

  it('gives the harvester enough time for a cold run', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Description: Match.stringLikeRegexp('BBB contractor reputation harvest'),
      Timeout: 900,
    });
  });

  it('creates exactly one worker', () => {
    const functions = Object.values(
      template.findResources('AWS::Lambda::Function'),
    ) as { Properties?: { Description?: string } }[];
    const harvesters = functions.filter((resource) =>
      /BBB contractor reputation/.test(resource.Properties?.Description ?? ''),
    );
    expect(harvesters).toHaveLength(1);
  });

  it('does not retry a refusal from bbb.org', () => {
    const machines = Object.values(template.findResources('AWS::StepFunctions::StateMachine'));
    const definition = JSON.stringify(machines);
    expect(definition).toContain('TransientRequestError');
    // Retrying into a block would risk the only access path this tier has.
    expect(definition).not.toContain('BbbBlockedError');
  });

  it('routes failure through the notifier before failing', () => {
    const definition = JSON.stringify(
      Object.values(template.findResources('AWS::StepFunctions::StateMachine')),
    );
    expect(definition).toContain('BbbHarvestPageOnCall');
    expect(definition).toContain('BbbHarvestFailed');
  });

  it('leaves the monthly schedule disabled outside prod', () => {
    template.hasResourceProperties('AWS::Events::Rule', {
      ScheduleExpression: 'cron(0 7 1 * ? *)',
      State: 'DISABLED',
    });
  });
});
