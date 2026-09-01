/**
 * The licence stack's shape.
 *
 * These assert the properties that keep this tier a polite citizen of a public site and that
 * make its failure modes legible — one concurrent worker, retries only where a retry can
 * actually help, and a schedule that is genuinely on — rather than the template's contents.
 */
import { SERVICE_NAME } from '@oracle-seminole/shared';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';
import { CoreStack } from '../../cdk/lib/core-stack';
import { LicenceStack } from '../../cdk/lib/licence-stack';

describe('LicenceStack', () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const env = { account: '795366345505', region: 'us-east-2' };
    const tags = { project_name: SERVICE_NAME, environment: 'dev' };
    const core = new CoreStack(app, 'TestLicenceCore', { env, tags, targetEnv: 'dev' });
    const licences = new LicenceStack(app, 'TestLicences', {
      env,
      tags,
      targetEnv: 'dev',
      alertNotifier: core.alertNotifier.handler,
      dataBucket: core.dataBucket,
    });
    template = Template.fromStack(licences);
  });

  it('pins the harvester to a single concurrent execution', () => {
    // Two instances would double the request rate at a host whose bot management escalates.
    template.hasResourceProperties('AWS::Lambda::Function', {
      Description: Match.stringLikeRegexp('DBPR contractor licence harvest'),
      ReservedConcurrentExecutions: 1,
    });
  });

  it('gives the harvester the full timeout and room to decode the extract', () => {
    /**
     * 48.8 MB of latin-1 becomes ~97 MB as a JavaScript string before the parse pass, and the
     * download itself was measured anywhere between 14s and 260s.
     */
    template.hasResourceProperties('AWS::Lambda::Function', {
      Description: Match.stringLikeRegexp('DBPR contractor licence harvest'),
      Timeout: 900,
      MemorySize: 2048,
    });
  });

  it('creates exactly one worker', () => {
    const functions = Object.values(
      template.findResources('AWS::Lambda::Function'),
    ) as { Properties?: { Description?: string } }[];
    const harvesters = functions.filter((resource) =>
      /DBPR contractor licence/.test(resource.Properties?.Description ?? ''),
    );
    expect(harvesters).toHaveLength(1);
  });

  it('retries a transient fault and a measured throttle, but never a changed source', () => {
    const definition = JSON.stringify(
      Object.values(template.findResources('AWS::StepFunctions::StateMachine')),
    );
    expect(definition).toContain('TransientRequestError');
    // Diverges from BBB deliberately: this throttle was measured and is self-clearing.
    expect(definition).toContain('DbprThrottledError');
    /**
     * A moved URL, a changed layout or a truncated transfer wearing a 200 is not fixed by
     * retrying, and quietly retrying it would delay the page that should already have fired.
     */
    expect(definition).not.toContain('ImplausibleExtractError');
  });

  it('routes failure through the notifier before failing', () => {
    const definition = JSON.stringify(
      Object.values(template.findResources('AWS::StepFunctions::StateMachine')),
    );
    expect(definition).toContain('LicenceHarvestPageOnCall');
    expect(definition).toContain('LicenceHarvestFailed');
  });

  it('runs the weekly schedule in dev, clear of the other timers', () => {
    /**
     * `?? true` on purpose: dev is the environment reviewers exercise, so a schedule that is
     * defined but never fires proves nothing. Wednesday 12:00 UTC sits after the source's
     * ~10:48 regeneration and clear of the nightly roll (06:00), BBB (07:00) and permits
     * (Sunday 09:00).
     */
    template.hasResourceProperties('AWS::Events::Rule', {
      ScheduleExpression: 'cron(0 12 ? * WED *)',
      State: 'ENABLED',
    });
  });
});
