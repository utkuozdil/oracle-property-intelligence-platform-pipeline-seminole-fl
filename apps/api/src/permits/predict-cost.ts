/**
 * The cost prediction gate. First step of the harvest that costs anything, and it runs
 * before a single request is made to either portal.
 *
 * The dominant term is not compute. It is time: Source B costs about 2.3 s per permit and
 * the ceiling exists mainly to stop somebody accidentally asking for the 82-hour variant of
 * this workflow. So the estimate is reported in dollars *and* in wall-clock hours, and the
 * gate trips on either.
 */
import { injectLambdaContext } from '@aws-lambda-powertools/logger/middleware';
import { MetricUnit } from '@aws-lambda-powertools/metrics';
import { logMetrics } from '@aws-lambda-powertools/metrics/middleware';
import { captureLambdaHandler } from '@aws-lambda-powertools/tracer/middleware';
import middy from '@middy/core';
import { UNIVERSAL_METRICS, predictInvocationCostUsd } from '@oracle-seminole/shared';
import { logger, metrics, tracer } from '../observability';
import { SOURCE_A_CONCURRENCY, SOURCE_B_CONCURRENCY } from './config';
import type { PlanSweepOutput } from './plan-sweep';

/** us-east-2 on-demand list prices. */
const S3_PUT_USD_PER_1K = 0.005;
const S3_GET_USD_PER_1K = 0.0004;
const DDB_WRITE_USD_PER_MILLION = 1.25;
const DDB_READ_USD_PER_MILLION = 0.25;
/** Standard workflows bill per state transition; a Distributed Map child is several. */
const SFN_TRANSITION_USD = 0.000025;

/** Measured medians: 0.56 s per Source A page, 2.3 s per Source B permit. */
const SOURCE_A_SECONDS_PER_REQUEST = 0.6;
const SOURCE_B_SECONDS_PER_PERMIT = 2.3;

const CENSUS_WORKER_MEMORY_MB = 1_024;
const STATUS_WORKER_MEMORY_MB = 1_024;

/**
 * Defaults, both deliberately conservative fixed ceilings rather than tunables.
 *
 * The harvest itself is cheap — it is HTTP against two county web servers — so a low dollar
 * ceiling is a tripwire for "this run is much bigger than intended" rather than a budget.
 * The hours ceiling is the one that will actually fire, and 12 hours is chosen to allow a
 * full 31-year `ALL TYPES` census (under 4 h) plus a 24-month status window (~1.2 h at
 * concurrency 3) while refusing the 82-hour full-history status sweep outright.
 */
export const COST_CEILING_USD = 25;
export const DURATION_CEILING_HOURS = 12;

export interface PredictHarvestCostInput {
  runId: string;
  plan: PlanSweepOutput;
}

export interface PredictHarvestCostOutput {
  runId: string;
  status: 'APPROVED' | 'APPROVAL_REQUIRED';
  estimatedCostUsd: number;
  ceilingUsd: number;
  estimatedHours: number;
  ceilingHours: number;
  breakdown: {
    censusRequests: number;
    censusLambdaUsd: number;
    statusPermits: number;
    statusLambdaUsd: number;
    storageUsd: number;
    stateTransitionsUsd: number;
    censusHours: number;
    statusHours: number;
  };
  reasons: string[];
  message: string;
}

async function baseHandler(event: PredictHarvestCostInput): Promise<PredictHarvestCostOutput> {
  const { plan } = event;
  const ceilingUsd = plan.scope.costCeilingUsd ?? COST_CEILING_USD;

  const censusRequests = plan.estimates.estimatedRequests;
  const censusSeconds = censusRequests * SOURCE_A_SECONDS_PER_REQUEST;
  // Workers bill for wall-clock time including the politeness delays, because the delay is
  // spent inside the invocation. That is the honest number.
  const censusLambdaUsd =
    predictInvocationCostUsd(censusSeconds * 1_000, CENSUS_WORKER_MEMORY_MB) +
    plan.estimates.shardCount * predictInvocationCostUsd(0, CENSUS_WORKER_MEMORY_MB);

  const statusPermits = plan.scope.censusOnly ? 0 : plan.scope.statusPermitLimit;
  // Two requests per permit, always: the status POST plus the inspections GET. Inspections
  // are read for open permits too, because a final inspection can be approved before the
  // status flips and inspection progress is itself a signal.
  const statusSeconds = statusPermits * SOURCE_B_SECONDS_PER_PERMIT * 2;
  const statusLambdaUsd = predictInvocationCostUsd(statusSeconds * 1_000, STATUS_WORKER_MEMORY_MB);

  // Raw HTML is written before it is parsed, so every page and every permit view is a PUT.
  const puts = censusRequests + plan.estimates.shardCount + statusPermits * 2 + 50;
  const storageUsd =
    (puts / 1_000) * S3_PUT_USD_PER_1K +
    (statusPermits / 1_000) * S3_GET_USD_PER_1K +
    (statusPermits / 1_000_000) * DDB_WRITE_USD_PER_MILLION +
    (statusPermits / 1_000_000) * DDB_READ_USD_PER_MILLION;

  const stateTransitions = (plan.estimates.shardCount + Math.ceil(statusPermits / 150)) * 8 + 40;
  const stateTransitionsUsd = stateTransitions * SFN_TRANSITION_USD;

  const estimatedCostUsd = censusLambdaUsd + statusLambdaUsd + storageUsd + stateTransitionsUsd;
  const censusHours = censusSeconds / SOURCE_A_CONCURRENCY / 3_600;
  const statusHours = statusSeconds / SOURCE_B_CONCURRENCY / 3_600;
  const estimatedHours = censusHours + statusHours;

  const reasons: string[] = [];
  if (estimatedCostUsd > ceilingUsd) {
    reasons.push(
      `estimated $${estimatedCostUsd.toFixed(2)} exceeds the $${ceilingUsd.toFixed(2)} ceiling`,
    );
  }
  if (estimatedHours > DURATION_CEILING_HOURS) {
    reasons.push(
      `estimated ${estimatedHours.toFixed(1)} h exceeds the ${DURATION_CEILING_HOURS} h ceiling`,
    );
  }

  metrics.addMetric(UNIVERSAL_METRICS.costPredicted, MetricUnit.NoUnit, estimatedCostUsd);

  const output: PredictHarvestCostOutput = {
    runId: event.runId,
    status: reasons.length > 0 ? 'APPROVAL_REQUIRED' : 'APPROVED',
    estimatedCostUsd: Number(estimatedCostUsd.toFixed(4)),
    ceilingUsd,
    estimatedHours: Number(estimatedHours.toFixed(2)),
    ceilingHours: DURATION_CEILING_HOURS,
    breakdown: {
      censusRequests,
      censusLambdaUsd: Number(censusLambdaUsd.toFixed(4)),
      statusPermits,
      statusLambdaUsd: Number(statusLambdaUsd.toFixed(4)),
      storageUsd: Number(storageUsd.toFixed(4)),
      stateTransitionsUsd: Number(stateTransitionsUsd.toFixed(4)),
      censusHours: Number(censusHours.toFixed(2)),
      statusHours: Number(statusHours.toFixed(2)),
    },
    reasons,
    message:
      reasons.length > 0
        ? `Manual approval required: ${reasons.join('; ')}.`
        : `Estimated $${estimatedCostUsd.toFixed(2)} and ${estimatedHours.toFixed(1)} h, ` +
          `within the $${ceilingUsd.toFixed(2)} / ${DURATION_CEILING_HOURS} h ceilings.`,
  };

  logger.info('Predicted permit harvest cost', { estimate: output });
  return output;
}

export const handler = middy(baseHandler)
  .use(injectLambdaContext(logger))
  .use(captureLambdaHandler(tracer))
  .use(logMetrics(metrics));
