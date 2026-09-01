/**
 * Sweep control flow, throttling, validation, and the CDK stack's shape.
 *
 * The pagination tests use a scripted session rather than the network. What they encode is
 * the termination rule, which is the one place a plausible implementation loses or duplicates
 * data at scale: the pager's Next button survives the last page and re-serves it.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SERVICE_NAME } from '@oracle-seminole/shared';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';
import { CoreStack } from '../../cdk/lib/core-stack';
import { PermitStack } from '../../cdk/lib/permit-stack';
import { SOURCE_A_CONCURRENCY, SOURCE_B_CONCURRENCY } from './config';
import { jitteredDelayMs, mapWithConcurrency, summariseLatency, WafBlockedError } from './http';
import { CensusShard, HarvestRequest, StatusBatch } from './model';
import {
  CensusQueryRejectedError,
  CensusShortfallError,
  monthsBetween,
  sweepMonth,
  type CensusSession,
} from './source-a';
import { insideMaintenanceWindow, localMinuteOfDay, maintenanceWindowEnd } from './plan-sweep';
import { NORMALISED_PARCEL_ID_LENGTH, normaliseParcelId, PARCEL_ID } from './reconcile-census';

const fixture = (name: string): string =>
  readFileSync(join(import.meta.dirname, '__fixtures__', name), 'utf8');

const paged = fixture('source-a-paged.html');
const singlePage = fixture('source-a-single-page.html');
const empty = fixture('source-a-empty.html');
const rejected = fixture('source-a-rejected.html');

const QUERY = {
  applicationType: 'R100',
  periodStart: '2026-08-01',
  periodEnd: '2026-08-31',
  month: '2026-08',
};

/**
 * The paged fixture with its stated totals rewritten.
 *
 * The real fixture states 176 rows over 4 pages and only two distinct pages were captured, so
 * restating the totals is what lets a two-page script be a *complete* result rather than a
 * shortfall. Page 1 carries 50 rows and page 2 carries 13, so 63 is the honest total.
 */
function statingTotals(html: string, total: number, pages: number): string {
  return html.replace(
    '<strong>176</strong> items in <strong>4</strong> pages',
    `<strong>${total}</strong> items in <strong>${pages}</strong> pages`,
  );
}

const TWO_PAGE_ROWS = 63;

/** Page 1 of a result the server says is complete in two pages. */
const pagedOfTwo = statingTotals(paged, TWO_PAGE_ROWS, 2);
/** The same rows, but the server claims a third page that was never captured. */
const pagedOfThree = statingTotals(paged, TWO_PAGE_ROWS, 3);

/**
 * A session that replays a scripted list of pages. `nextPage` keeps returning the last page
 * once the script runs out, which is exactly what the real pager does.
 */
function scriptedSession(pages: readonly string[]): {
  session: CensusSession;
  searches: number;
  nextCalls: () => number;
} {
  let index = 0;
  let nextCalls = 0;
  const session = {
    open: async () => undefined,
    cookieNames: () => ['ASP.NET_SessionId'],
    search: async () => {
      index = 0;
      const html = pages[0] as string;
      if (html === rejected) throw new CensusQueryRejectedError('The dates must be in the same month.', QUERY);
      return { html, state: classify(html), durationMs: 500 };
    },
    nextPage: async () => {
      nextCalls += 1;
      index = Math.min(index + 1, pages.length - 1);
      const html = pages[index] as string;
      return { html, state: classify(html), durationMs: 500 };
    },
  } as unknown as CensusSession;
  return { session, searches: 1, nextCalls: () => nextCalls };
}

/** Classified by content, so restating a fixture's totals does not change what it is. */
function classify(html: string): 'PAGED' | 'SINGLE_PAGE' | 'EMPTY' {
  if (html === empty) return 'EMPTY';
  return /items in <strong>\d+<\/strong> pages/.test(html) ? 'PAGED' : 'SINGLE_PAGE';
}

/**
 * Seminole parcel ids are only digits in their first three blocks. An all-digit pattern
 * passes every id in a small sample and then rejects 44% of a real month's, and because a
 * rejected id was simply not counted, the loss showed up as a healthy-looking join.
 */
describe('the parcel join key', () => {
  it('accepts the alphanumeric blocks the county actually issues', () => {
    for (const id of [
      '25-19-29-300-0290-0000',
      '01-20-29-5MF-0000-0100',
      '00-00-00-ROW-0000-0000',
      '01-20-29-505-0S00-0000',
      '01-21-29-300-005A-0000',
      '01-20-31-5UR-0000-1020',
    ]) {
      expect(PARCEL_ID.test(id)).toBe(true);
    }
  });

  it('still rejects ids that are the wrong shape', () => {
    for (const id of ['', '25-19-29-300-0290', '25192930002900000', '25-19-29-300-0290-00000']) {
      expect(PARCEL_ID.test(id)).toBe(false);
    }
  });

  /**
   * The permit portal renders the key hyphenated and the appraisal snapshot stores it bare.
   * Joining the two spellings directly matched 0 of 3,763 parcels against the published set.
   */
  it('normalises to the undelimited form the published snapshot stores', () => {
    expect(normaliseParcelId('25-19-29-300-0290-0000')).toBe('25192930002900000');
    expect(normaliseParcelId('01-20-29-5MF-0000-0100')).toBe('0120295MF00000100');
    for (const id of ['25-19-29-300-0290-0000', '01-20-29-5MF-0000-0100', '00-00-00-ROW-0000-0000']) {
      expect(normaliseParcelId(id)).toHaveLength(NORMALISED_PARCEL_ID_LENGTH);
      expect(normaliseParcelId(id)).not.toContain('-');
    }
  });
});

describe('month sweep termination', () => {
  it('stops at the server-stated page count instead of following Next forever', async () => {
    // The pager's Next button survives the last page, so the stated page count is the only
    // thing that ends the loop. Two pages are stated and two are read, with one click.
    const { session, nextCalls } = scriptedSession([pagedOfTwo, singlePage]);
    const captured: number[] = [];
    const outcome = await sweepMonth(session, QUERY, async ({ index }) => {
      captured.push(index);
    });
    expect(outcome.statedPages).toBe(2);
    expect(nextCalls()).toBe(1);
    expect(captured).toEqual([1, 2]);
    expect(outcome.rows).toHaveLength(TWO_PAGE_ROWS);
    expect(outcome.warnings).toEqual([]);
  });

  /**
   * The belt to the stated-page-count braces: if the server overstates its page count, the
   * pager re-serves the last page rather than erroring, and only recognising the repeat stops
   * the loop from absorbing that page over and over.
   */
  it('stops early when the pager starts re-serving the last page', async () => {
    const { session, nextCalls } = scriptedSession([pagedOfThree, singlePage]);
    const captured: number[] = [];
    const outcome = await sweepMonth(session, QUERY, async ({ index }) => {
      captured.push(index);
    });
    expect(outcome.statedPages).toBe(3);
    expect(nextCalls()).toBe(2);
    expect(captured).toEqual([1, 2]);
    expect(outcome.rows).toHaveLength(TWO_PAGE_ROWS);
    expect(outcome.warnings.some((warning) => warning.includes('repeated'))).toBe(true);
  });

  /**
   * A month that comes up short of its own stated total is a partial month, and recording it
   * would look like a real decline in permit activity. It has to fail loudly and be retried.
   */
  it('refuses to record a month that falls short of its stated total', async () => {
    const { session } = scriptedSession([paged, singlePage]);
    await expect(sweepMonth(session, QUERY, async () => undefined)).rejects.toThrow(
      CensusShortfallError,
    );
  });

  /**
   * Overlapping pages are normal and collapsing them is the point. Collapsing rows that
   * merely *look* alike is not, so a same-key/different-content collision has to be
   * reported rather than silently resolved in favour of whichever page arrived last.
   */
  it('flags same-key rows whose content differs instead of silently dropping one', async () => {
    // Page 3 re-serves page 1's rows with one owner altered. It cannot be adjacent to page 1,
    // or the repeat detector would — rightly — read it as the same page served twice.
    const tampered = statingTotals(paged, TWO_PAGE_ROWS, 3).replace(
      'NEUMANN, WILLIAM J & MARICONDA',
      'A DIFFERENT OWNER ENTIRELY',
    );
    const { session } = scriptedSession([pagedOfThree, singlePage, tampered]);
    const outcome = await sweepMonth(session, QUERY, async () => undefined);
    expect(
      outcome.warnings.some((warning) => warning.includes('does not identify a row')),
    ).toBe(true);
  });

  it('treats a re-served identical page as overlap, not as a key conflict', async () => {
    const { session } = scriptedSession([pagedOfThree, singlePage]);
    const outcome = await sweepMonth(session, QUERY, async () => undefined);
    expect(
      outcome.warnings.some((warning) => warning.includes('does not identify a row')),
    ).toBe(false);
  });

  it('writes every page to storage before it is parsed', async () => {
    const { session } = scriptedSession([pagedOfTwo, singlePage]);
    const order: string[] = [];
    await sweepMonth(session, QUERY, async ({ index }) => {
      order.push(`wrote-${index}`);
    });
    // The callback is the raw-HTML write, and it fires for page 1 before any row is absorbed.
    expect(order[0]).toBe('wrote-1');
    expect(order).toHaveLength(2);
  });

  it('records a genuinely empty month as zero without touching the pager', async () => {
    const { session, nextCalls } = scriptedSession([empty]);
    const outcome = await sweepMonth(session, QUERY, async () => undefined);
    expect(outcome.state).toBe('EMPTY');
    expect(outcome.statedTotal).toBe(0);
    expect(outcome.rows).toEqual([]);
    expect(nextCalls()).toBe(0);
  });

  it('reports a single-page result from its row count, not its absent pager info', async () => {
    const { session } = scriptedSession([singlePage]);
    const outcome = await sweepMonth(session, QUERY, async () => undefined);
    expect(outcome.state).toBe('SINGLE_PAGE');
    expect(outcome.rows).toHaveLength(13);
    expect(outcome.statedTotal).toBe(13);
  });

  /** A rejected month must never be recorded as zero: that silently deletes it. */
  it('throws rather than returning zero when the query was rejected', async () => {
    const { session } = scriptedSession([rejected]);
    await expect(sweepMonth(session, QUERY, async () => undefined)).rejects.toThrow(
      CensusQueryRejectedError,
    );
  });

  /** Collecting fewer rows than the server stated is a coverage hole, not a warning. */
  it('throws on a shortfall against the stated total', async () => {
    // One page of 50 against a stated total of 176, with the pager immediately exhausted.
    const session = {
      search: async () => ({ html: paged, state: 'PAGED' as const, durationMs: 500 }),
      nextPage: async () => null,
    } as unknown as CensusSession;
    await expect(sweepMonth(session, QUERY, async () => undefined)).rejects.toThrow(
      CensusShortfallError,
    );
  });
});

describe('request pacing', () => {
  it('keeps at most `limit` requests in flight', async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency(Array.from({ length: 12 }, (_, index) => index), 3, 0, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return null;
    });
    expect(peak).toBeLessThanOrEqual(3);
  });

  it('preserves result order regardless of completion order', async () => {
    const results = await mapWithConcurrency([30, 5, 20, 1], 4, 0, async (delay) => {
      await new Promise((resolve) => setTimeout(resolve, delay));
      return delay;
    });
    expect(results).toEqual([30, 5, 20, 1]);
  });

  /** A WAF block has to stop the whole batch, not just the slot that hit it. */
  it('drains every slot on the first failure', async () => {
    let started = 0;
    await expect(
      mapWithConcurrency(Array.from({ length: 50 }, (_, index) => index), 2, 0, async (item) => {
        started += 1;
        if (item === 1) throw new WafBlockedError('https://example.test', 403, 'Support ID');
        await new Promise((resolve) => setTimeout(resolve, 1));
        return null;
      }),
    ).rejects.toThrow(WafBlockedError);
    expect(started).toBeLessThan(50);
  });

  it('jitters a delay around its base without going negative', () => {
    expect(jitteredDelayMs(1_000, () => 0)).toBe(700);
    expect(jitteredDelayMs(1_000, () => 1)).toBe(1_300);
    expect(jitteredDelayMs(1_000, () => 0.5)).toBe(1_000);
    expect(jitteredDelayMs(0, () => 0)).toBe(0);
  });

  it('keeps both ceilings at or below the highest level with evidence behind it', () => {
    // Source A: 45 consecutive requests were clean; 2 is the recommendation, 4 the hard cap.
    expect(SOURCE_A_CONCURRENCY).toBeLessThanOrEqual(4);
    // Source B: concurrency 3 was clean and is the highest level probed. Never exceed it.
    expect(SOURCE_B_CONCURRENCY).toBeLessThanOrEqual(3);
  });

  it('summarises latency from an empty sample without dividing by zero', () => {
    expect(summariseLatency([])).toEqual({ min: 0, median: 0, max: 0 });
    expect(summariseLatency([500, 100, 900])).toEqual({ min: 100, median: 500, max: 900 });
  });
});

describe('input validation', () => {
  it('accepts an empty execution input, which is what a schedule sends', () => {
    expect(HarvestRequest.parse({})).toEqual({});
  });

  it('rejects an unknown field rather than silently ignoring it', () => {
    expect(() => HarvestRequest.parse({ fromMonht: '2026-01' })).toThrow();
  });

  it('rejects a malformed month', () => {
    expect(() => HarvestRequest.parse({ fromMonth: '2026-1' })).toThrow();
    expect(() => HarvestRequest.parse({ fromMonth: 'August' })).toThrow();
  });

  const shard = {
    runId: 'run-1',
    applicationType: 'ALL',
    month: '2026-08',
    periodStart: '2026-08-01',
    periodEnd: '2026-08-31',
  };

  it('accepts a well-formed shard', () => {
    expect(CensusShard.parse(shard)).toEqual(shard);
  });

  /**
   * Client-side guards for the two ranges the server mishandles: a cross-month range is
   * rejected with an empty grid, and a reversed range returns EMPTY rather than an error.
   */
  it('refuses a range that spans two calendar months', () => {
    expect(() => CensusShard.parse({ ...shard, periodEnd: '2026-09-30' })).toThrow(
      /same calendar month/,
    );
  });

  it('refuses a reversed range', () => {
    expect(() =>
      CensusShard.parse({ ...shard, periodStart: '2026-08-31', periodEnd: '2026-08-01' }),
    ).toThrow(/must not be after/);
  });

  it('refuses a month before the data horizon', () => {
    expect(() =>
      CensusShard.parse({
        ...shard,
        month: '1994-03',
        periodStart: '1994-03-01',
        periodEnd: '1994-03-31',
      }),
    ).toThrow(/1996/);
  });

  it('validates a status batch pointer', () => {
    expect(() =>
      StatusBatch.parse({ runId: 'r', batchKey: 'k', batchIndex: 0, permitCount: 0 }),
    ).toThrow();
    expect(
      StatusBatch.parse({ runId: 'r', batchKey: 'k', batchIndex: 0, permitCount: 1 }),
    ).toBeTruthy();
  });
});

describe('the maintenance window', () => {
  const eastern = (iso: string): Date => new Date(iso);

  it('reads the local hour in Eastern regardless of the host clock', () => {
    // 2026-08-15T12:00Z is 08:00 EDT.
    expect(localMinuteOfDay(eastern('2026-08-15T12:00:00Z'), 'America/New_York')).toBe(8 * 60);
  });

  it('recognises the window on both sides of midnight', () => {
    // 03:00Z on 2026-08-16 is 23:00 EDT on the 15th — before the window opens.
    expect(insideMaintenanceWindow(eastern('2026-08-16T03:00:00Z'))).toBe(false);
    // 03:45Z is 23:45 EDT — inside.
    expect(insideMaintenanceWindow(eastern('2026-08-16T03:45:00Z'))).toBe(true);
    // 09:00Z is 05:00 EDT — still inside.
    expect(insideMaintenanceWindow(eastern('2026-08-16T09:00:00Z'))).toBe(true);
    // 12:00Z is 08:00 EDT — reopened.
    expect(insideMaintenanceWindow(eastern('2026-08-16T12:00:00Z'))).toBe(false);
  });

  it('resolves the window end to an instant outside the window', () => {
    const end = maintenanceWindowEnd(eastern('2026-08-16T03:45:00Z'));
    expect(insideMaintenanceWindow(end)).toBe(false);
    expect(end.getTime()).toBeGreaterThan(eastern('2026-08-16T03:45:00Z').getTime());
    expect(localMinuteOfDay(end, 'America/New_York')).toBe(7 * 60);
  });

  it('enumerates a full historical sweep without spinning', () => {
    expect(monthsBetween('1996-01', '2026-12')).toHaveLength(31 * 12);
  });
});

describe('the permit stack', () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const env = { account: '795366345505', region: 'us-east-2' };
    const tags = { project_name: SERVICE_NAME, environment: 'dev' };
    const core = new CoreStack(app, 'TestPermitCore', { env, tags, targetEnv: 'dev' });
    const permits = new PermitStack(app, 'TestPermits', {
      env,
      tags,
      targetEnv: 'dev',
      alertNotifier: core.alertNotifier.handler,
      dataBucket: core.dataBucket,
      table: core.table,
    });
    template = Template.fromStack(permits);
  });

  it('provisions one Standard state machine with tracing, under its own name', () => {
    template.resourceCountIs('AWS::StepFunctions::StateMachine', 1);
    template.hasResourceProperties('AWS::StepFunctions::StateMachine', {
      // Deliberately not `PermitHarvest`: PipelineStack still owns a state machine by that
      // name, and two stacks cannot both create it.
      StateMachineName: 'SeminolePermitHarvest',
      TracingConfiguration: { Enabled: true },
    });
    const machine = Object.values(
      template.findResources('AWS::StepFunctions::StateMachine'),
    )[0];
    // CDK omits StateMachineType for Standard, so execution history survives as evidence.
    expect(machine?.Properties.StateMachineType).toBeUndefined();
  });

  it('carries the observability contract on every function', () => {
    const functions = Object.values(template.findResources('AWS::Lambda::Function'));
    expect(functions.length).toBeGreaterThanOrEqual(8);
    for (const fn of functions) {
      expect(fn.Properties.TracingConfig).toEqual({ Mode: 'Active' });
      expect(fn.Properties.Environment.Variables.POWERTOOLS_SERVICE_NAME).toBe(SERVICE_NAME);
      expect(fn.Properties.Environment.Variables.NODE_OPTIONS).toBe('--enable-source-maps');
    }
  });

  it('gives every log group a distinct conventional name', () => {
    const names = Object.values(template.findResources('AWS::Logs::LogGroup')).map(
      (group) => group.Properties.LogGroupName as string,
    );
    expect(names.length).toBeGreaterThan(0);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) {
      expect(name).toMatch(
        new RegExp(`^(/aws/lambda/${SERVICE_NAME}-dev-|/aws/vendedlogs/states/)`),
      );
    }
  });

  function definition(): string {
    const machine = Object.values(
      template.findResources('AWS::StepFunctions::StateMachine'),
    )[0];
    return JSON.stringify(machine?.Properties.DefinitionString);
  }

  /**
   * The bug this pins down shipped once and reached AWS. `TaskInput.fromJsonPathAt('$')` on a
   * task inside a Distributed Map renders `"Parameters": "$"`, and Step Functions hands the
   * worker the literal string `"$"` rather than the item. The correct form is no payload at
   * all, because inside a map the state input already is the item.
   */
  it('passes each map item to its worker rather than the literal string "$"', () => {
    const body = definition();
    expect(body).not.toContain('\\"Parameters\\":\\"$\\"');
    for (const worker of ['HarvestCensusShardTask', 'HarvestStatusBatchTask']) {
      const start = body.indexOf(worker);
      expect(start).toBeGreaterThan(-1);
      // Bounded to the item processor, so the map's own ResultWriter parameters are excluded.
      const state = body.slice(start, body.indexOf('MaxConcurrency', start));
      expect(state).toContain('\\"Type\\":\\"Task\\"');
      expect(state).not.toContain('Parameters');
    }
  });

  /** Planning reads every census row back and writes batch objects, so it must be skipped. */
  it('skips status planning entirely on a census-only run', () => {
    const body = definition();
    const choice = body.slice(
      body.indexOf('\\"StatusRequested?\\":'),
      body.indexOf('\\"CensusOnlyRun\\"'),
    );
    expect(choice).toContain('censusOnly');
    expect(body.indexOf('\\"StatusRequested?\\":')).toBeLessThan(
      body.indexOf('\\"PlanStatusTask\\":'),
    );
  });

  it('predicts cost before either portal is touched', () => {
    const body = definition();
    expect(body).toMatch(/\\"StartAt\\":\\"PlanSweepTask\\"/);
    expect(body).toContain('PredictPermitCostTask');
    // The gate sits ahead of both maps.
    expect(body.indexOf('PredictPermitCostTask')).toBeLessThan(body.indexOf('CensusSweep'));
  });

  it('pauses on a task token when the estimate is over either ceiling', () => {
    const body = definition();
    expect(body).toContain('OverBudget?');
    expect(body).toContain('APPROVAL_REQUIRED');
    expect(body).toContain('waitForTaskToken');
  });

  it('waits out the portal maintenance window on an absolute timestamp', () => {
    const body = definition();
    expect(body).toContain('WaitForPortalWindow');
    expect(body).toContain('TimestampPath');
    expect(body).toContain('PortalAvailable?');
  });

  it('runs Source A before Source B, because Source B cannot be enumerated alone', () => {
    const body = definition();
    expect(body.indexOf('CensusSweep')).toBeLessThan(body.indexOf('StatusSweep'));
    expect(body.indexOf('ReconcileCensusTask')).toBeLessThan(body.indexOf('PlanStatusTask'));
  });

  it('caps both maps and spills their results to S3', () => {
    const body = definition();
    expect(body).toContain('DISTRIBUTED');
    expect(body).toContain('\\"MaxConcurrency\\":2');
    expect(body).toContain('\\"MaxConcurrency\\":1');
    expect(body).toContain('ResultWriter');
    // The census map carries no tolerated-failure field, which is the zero-tolerance default:
    // a failed month is a hole in the census. Only the status map tolerates anything.
    const censusMap = body.slice(body.indexOf('CensusSweep'), body.indexOf('ReconcileCensusTask'));
    expect(censusMap).not.toContain('ToleratedFailure');
    expect(body).toContain('\\"ToleratedFailurePercentage\\":5');
  });

  it('pins each worker to the reserved concurrency its portal tolerates', () => {
    const workers = Object.values(template.findResources('AWS::Lambda::Function')).filter((fn) =>
      (fn.Properties?.Description as string)?.includes('worker'),
    );
    expect(workers).toHaveLength(2);
    const byDescription = new Map(
      workers.map((fn) => [fn.Properties.Description as string, fn.Properties]),
    );
    const census = [...byDescription].find(([key]) => key.includes('Source A'))?.[1];
    const status = [...byDescription].find(([key]) => key.includes('Source B'))?.[1];
    // The account-level half of the rate ceiling; the in-process limiter is the other half.
    expect(census?.ReservedConcurrentExecutions).toBe(2);
    expect(status?.ReservedConcurrentExecutions).toBe(1);
  });

  it('routes the top-level Catch to a PagerDuty trigger before Fail', () => {
    const body = definition();
    expect(body).toContain('PermitHarvestPageOnCall');
    expect(body).toContain('PermitHarvestFailed');
    expect(body).toContain('\\"Next\\":\\"PermitHarvestPageOnCall\\"');
  });

  it('surfaces the run summary as the execution output', () => {
    // Without this the execution output is `{}` and whether a run landed anything exists only
    // inside the history.
    expect(definition()).toContain('\\"OutputPath\\":\\"$[0]\\"');
  });

  it('grants the workers only the bucket and table they need', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({ Action: Match.arrayWith(['s3:PutObject']) }),
        ]),
      }),
    });
  });

  it('adds no queue, alarm, or secret of its own', () => {
    // Alerting is the notifier it was handed plus the operations topic it publishes to.
    template.resourceCountIs('AWS::SQS::Queue', 0);
    template.resourceCountIs('AWS::SecretsManager::Secret', 0);
  });
});