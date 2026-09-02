/**
 * Step one of the permit harvest: turn an execution input into an explicit list of shards,
 * and decide whether the sweep has to wait for the portal to come back up.
 *
 * Nothing here touches either portal. It exists so that what a run is about to do is a
 * durable, inspectable artifact before any request is made — the shard list is written to
 * S3 as well as returned, so a run's intended scope can be compared against what it
 * actually landed.
 */
import { injectLambdaContext } from '@aws-lambda-powertools/logger/middleware';
import { logMetrics } from '@aws-lambda-powertools/metrics/middleware';
import { captureLambdaHandler } from '@aws-lambda-powertools/tracer/middleware';
import middy from '@middy/core';
import { logger, metrics, tracer } from '../observability';
import {
  ALL_TYPES_CODE,
  COVERAGE,
  DATA_HORIZON_YEAR,
  GRID_PAGE_SIZE,
  MAINTENANCE_WINDOW,
} from './config';
import { HarvestRequest, type CensusShard } from './model';
import { putJson } from './objects';
import { monthBounds, monthsBetween } from './source-a';
import { planKey } from './storage';

/**
 * Rows per month under `ALL TYPES`, by era.
 *
 * A flat rate taken from 2025 overstates the 1990s by roughly a factor of three, which for a
 * 369-month backfill is a materially wrong figure in the cost gate and the ETA. Measured
 * June totals: 797 rows in 1996, 1,290 in 1998, 1,367 in 2000, against a 2025 mean of 2,160.
 */
export function estimatedRowsForMonth(month: string): number {
  const year = Number(month.slice(0, 4));
  if (year < 1998) return 900;
  if (year < 2005) return 1_400;
  return 2_160;
}

export interface PlanSweepInput {
  runId: string;
  /** The execution's own input, passed through whole so `{}` stays a valid run. */
  request?: unknown;
}

export interface PlanSweepOutput {
  runId: string;
  scope: {
    fromMonth: string;
    toMonth: string;
    applicationTypes: string[];
    censusOnly: boolean;
    statusOnly: boolean;
    statusWindowMonths: number;
    statusPermitLimit: number;
    statusFromMonth: string;
    statusOrder: 'newest' | 'oldest';
    statusRoofingOnly: boolean;
    statusRefreshDays: number;
    costCeilingUsd: number | null;
  };
  shards: CensusShard[];
  estimates: {
    shardCount: number;
    estimatedRows: number;
    estimatedPageRequests: number;
    estimatedRequests: number;
  };
  /** ISO timestamp the sweep must not start before, or null when it can start now. */
  waitUntil: string | null;
  coverage: typeof COVERAGE;
  planKey: string;
}

/** Minutes since local midnight in a named zone, without pulling in a date library. */
export function localMinuteOfDay(now: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? '0');
  // `hour12: false` renders midnight as 24 in some ICU versions.
  return (hour % 24) * 60 + minute;
}

export function insideMaintenanceWindow(now: Date): boolean {
  const minute = localMinuteOfDay(now, MAINTENANCE_WINDOW.timeZone);
  // The window wraps midnight, so "inside" is either side of it.
  return minute >= MAINTENANCE_WINDOW.startMinuteOfDay || minute < MAINTENANCE_WINDOW.endMinuteOfDay;
}

/**
 * When the portal comes back, as an absolute instant.
 *
 * Computed by walking forward in five-minute steps rather than by constructing a local
 * timestamp, which keeps it correct across the two days a year when the Eastern offset
 * changes and 07:00 is not a fixed number of hours away.
 */
export function maintenanceWindowEnd(now: Date): Date {
  let cursor = now.getTime();
  const step = 5 * 60_000;
  for (let guard = 0; guard < 24 * 12 + 1; guard += 1) {
    cursor += step;
    if (!insideMaintenanceWindow(new Date(cursor))) return new Date(cursor);
  }
  return new Date(now.getTime() + 8 * 3_600_000);
}

function monthOf(date: Date): string {
  return date.toISOString().slice(0, 7);
}

function shiftMonths(month: string, delta: number): string {
  const [year, index] = month.split('-').map(Number) as [number, number];
  const absolute = year * 12 + (index - 1) + delta;
  return `${Math.floor(absolute / 12)}-${String((absolute % 12) + 1).padStart(2, '0')}`;
}

async function baseHandler(event: PlanSweepInput): Promise<PlanSweepOutput> {
  const request = HarvestRequest.parse(event.request ?? {});
  const now = new Date();

  const toMonth = request.toMonth ?? monthOf(now);
  // Default scope is the incremental one: the current and previous calendar month. Whether
  // an already-harvested Source A row can change after issuance is untested, so recent
  // months are re-harvested rather than treated as immutable.
  const fromMonth = request.fromMonth ?? shiftMonths(toMonth, -1);
  if (fromMonth > toMonth) {
    throw new Error(`fromMonth ${fromMonth} is after toMonth ${toMonth}`);
  }
  if (Number(fromMonth.slice(0, 4)) < DATA_HORIZON_YEAR) {
    throw new Error(
      `fromMonth ${fromMonth} predates the ${DATA_HORIZON_YEAR} data horizon; 1990 and ` +
        '1993-1995 were probed and are genuinely empty',
    );
  }

  const applicationTypes = request.applicationTypes ?? [ALL_TYPES_CODE];
  const statusOnly = request.statusOnly === true;
  const months = monthsBetween(fromMonth, toMonth);
  const shards: CensusShard[] = [];
  if (!statusOnly) {
    for (const applicationType of applicationTypes) {
      for (const month of months) {
        shards.push({ runId: event.runId, applicationType, month, ...monthBounds(month) });
      }
    }
  }

  const sweepsAllTypes = applicationTypes.includes(ALL_TYPES_CODE);
  const estimatedRows = Math.round(
    months.reduce((total, month) => total + estimatedRowsForMonth(month), 0) *
      (sweepsAllTypes ? 1 : 0.1),
  );
  const estimatedPageRequests = Math.ceil(estimatedRows / GRID_PAGE_SIZE);

  const statusWindowMonths = request.statusWindowMonths ?? 24;
  const statusPermitLimit = request.statusPermitLimit ?? 6_000;
  const statusOrder = request.statusOrder ?? 'newest';
  /**
   * An oldest-first hunt defaults to the whole horizon. A trailing 24-month window and an
   * oldest-first ordering together would just return the oldest permits of the last two
   * years, which is not what asking for the oldest means.
   */
  const statusFromMonth =
    request.statusFromMonth ??
    (statusOrder === 'oldest'
      ? `${DATA_HORIZON_YEAR}-01`
      : shiftMonths(toMonth, -(statusWindowMonths - 1)));

  const waiting =
    !statusOnly && request.ignoreMaintenanceWindow !== true && insideMaintenanceWindow(now);
  const plan: PlanSweepOutput = {
    runId: event.runId,
    scope: {
      fromMonth,
      toMonth,
      applicationTypes,
      censusOnly: statusOnly ? false : (request.censusOnly ?? false),
      statusOnly,
      statusWindowMonths,
      statusPermitLimit,
      statusFromMonth,
      statusOrder,
      statusRoofingOnly: request.statusRoofingOnly ?? false,
      /**
       * Thirty days by default: long enough that a multi-tranche sweep of the whole roofing
       * population advances on every run rather than re-reading its own open permits, short
       * enough that a monthly refresh still re-checks every open permit for a status change.
       */
      statusRefreshDays: request.statusRefreshDays ?? 30,
      costCeilingUsd: request.costCeilingUsd ?? null,
    },
    shards,
    estimates: {
      shardCount: shards.length,
      estimatedRows,
      estimatedPageRequests,
      // One GET per shard's session plus one search POST plus the page requests.
      estimatedRequests: shards.length * 2 + estimatedPageRequests,
    },
    waitUntil: waiting ? maintenanceWindowEnd(now).toISOString() : null,
    coverage: COVERAGE,
    planKey: planKey(event.runId),
  };

  await putJson(plan.planKey, plan);

  logger.info('Planned permit sweep', {
    runId: event.runId,
    shardCount: shards.length,
    fromMonth,
    toMonth,
    applicationTypes,
    estimatedRows,
    waitUntil: plan.waitUntil,
  });

  return plan;
}

export const handler = middy(baseHandler)
  .use(injectLambdaContext(logger))
  .use(captureLambdaHandler(tracer))
  .use(logMetrics(metrics));
