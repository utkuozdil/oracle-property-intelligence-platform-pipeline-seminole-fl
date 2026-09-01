/**
 * Reconciles the census against the published parcel snapshot.
 *
 * Reads what the shards actually wrote, from S3, rather than trusting the state machine's
 * own view of them. A Distributed Map can complete green with every child having landed
 * nothing, so the summary this writes is derived from the objects in the bucket.
 *
 * The parcel join is the point of the exercise: a permit row is only useful if it attaches
 * to a published parcel, and the match rate against the 181,218 published parcels is the
 * figure that says whether it does.
 */
import { injectLambdaContext } from '@aws-lambda-powertools/logger/middleware';
import { logMetrics } from '@aws-lambda-powertools/metrics/middleware';
import { captureLambdaHandler } from '@aws-lambda-powertools/tracer/middleware';
import middy from '@middy/core';
import { logger, metrics, tracer } from '../observability';
import { COVERAGE } from './config';
import type { CensusRow } from './model';
import { getText, listKeys, putJson } from './objects';
import { publishedParcels } from './published-parcels';
import { monthsBetween } from './source-a';
import { CENSUS_PREFIX, censusSummaryKey, coverageKey, isCensusMonthRowsKey } from './storage';

export interface ReconcileCensusInput {
  runId: string;
  scope: {
    fromMonth: string;
    toMonth: string;
    applicationTypes: string[];
    statusFromMonth: string;
  };
}

export interface ReconcileCensusOutput {
  runId: string;
  /** Accumulated month objects read. One per `(month, type)` ever harvested. */
  shardsLanded: number;
  /** Rows in the accumulated dataset, which is every sweep's union rather than this run's. */
  rowsLanded: number;
  /** Rows this run was the first to see. On a re-harvest of known months this is near zero. */
  rowsFirstSeenThisRun: number;
  /** Rows this run saw again. Below the dataset total means earlier sweeps found more. */
  rowsConfirmedThisRun: number;
  /** Distinct `(AppNo, StructureSequence, PermitTypeSequence)` — one per trade permit. */
  distinctPermitRows: number;
  /** Distinct `AppNo`. Always lower than the row count; one application spans trades. */
  distinctApplications: number;
  distinctParcels: number;
  malformedParcelIds: number;
  roofingRows: number;
  emptyMonths: string[];
  monthlyRows: Record<string, number>;
  parcelMatch: {
    snapshotRunId: string;
    publishedParcels: number;
    matchedParcels: number;
    unmatchedParcels: number;
    joinRate: number;
    coveredShareOfPublished: number;
    unmatchedSamples: string[];
  };
  coverage: typeof COVERAGE & {
    /** Share of the *unincorporated* parcel base this run's permits touched. */
    unincorporatedTouchRate: number;
    countywideTouchRate: number;
  };
  summaryKey: string;
  coverageKey: string;
}

/**
 * A well-formed Seminole parcel id.
 *
 * The last three blocks are alphanumeric, not numeric. Requiring digits throughout looks
 * right and measured as right on a sample, but it silently rejected 44% of real ids —
 * `01-20-29-5MF-0000-0100`, `00-00-00-ROW-0000-0000`, `01-20-29-505-0S00-0000` — and the
 * rejects were then reported as if they had never existed.
 */
export const PARCEL_ID = /^\d{2}-\d{2}-\d{2}-[0-9A-Z]{3}-[0-9A-Z]{4}-[0-9A-Z]{4}$/;

/**
 * A parcel id in the form the published snapshot uses.
 *
 * The two sources spell the same key differently: the permit portal renders it hyphenated
 * (`25-19-29-300-0290-0000`) and the appraisal snapshot stores the bare 17 characters
 * (`251929300029 0000` without the space). Joining the two spellings directly matches
 * *nothing*, and because a zero-match join looks exactly like "this run touched no published
 * parcels", it has to be normalised rather than assumed compatible.
 */
export function normaliseParcelId(parcelId: string): string {
  return parcelId.replaceAll('-', '').toUpperCase();
}

/** Length of the undelimited parcel id. Every published id is exactly this. */
export const NORMALISED_PARCEL_ID_LENGTH = 17;

async function baseHandler(event: ReconcileCensusInput): Promise<ReconcileCensusOutput> {
  // The accumulated union, not this run's own sample of it. Reading the run's sample would
  // report coverage as whatever Source A's pager happened to hand over this time, which is
  // the oscillation the union exists to remove.
  const keys = (await listKeys(CENSUS_PREFIX)).filter(isCensusMonthRowsKey);

  const permitRows = new Set<string>();
  /**
   * Applications are counted separately from rows because one application number covers
   * several trade permits — electrical, plumbing, roof, fire — each its own row. Reporting
   * only one of the two invites reading trade-permit counts as application counts.
   */
  const applications = new Set<string>();
  const parcels = new Set<string>();
  const monthlyRows: Record<string, number> = {};
  let rowsLanded = 0;
  let roofingRows = 0;
  let malformedParcelIds = 0;
  let rowsFirstSeenThisRun = 0;
  let rowsConfirmedThisRun = 0;

  for (const key of keys) {
    const body = await getText(key);
    for (const line of body.split('\n')) {
      if (!line) continue;
      const row = JSON.parse(line) as CensusRow;
      rowsLanded += 1;
      permitRows.add(row.rowKey);
      applications.add(row.appNo);
      if (PARCEL_ID.test(row.parcelId)) parcels.add(row.parcelId);
      else malformedParcelIds += 1;
      if (row.roofingRelevant) roofingRows += 1;
      monthlyRows[row.month] = (monthlyRows[row.month] ?? 0) + 1;
      if (row.firstSeenRunId === event.runId) rowsFirstSeenThisRun += 1;
      if (row.lastSeenRunId === event.runId) rowsConfirmedThisRun += 1;
    }
  }

  /**
   * Months the sweep asked for and got nothing back for. Always empty before, which made a
   * genuinely empty month indistinguishable from one whose shard failed silently.
   */
  const emptyMonths = monthsBetween(event.scope.fromMonth, event.scope.toMonth).filter(
    (month) => (monthlyRows[month] ?? 0) === 0,
  );

  const published = await publishedParcels();
  /**
   * A real intersection, not a count of well-formed ids. `unmatched` is the interesting half:
   * it is either a parcel the appraisal snapshot has not published yet or a join key that
   * does not line up, and reporting it as zero without checking would hide both.
   */
  const matched = new Set<string>();
  const unmatched = new Set<string>();
  for (const parcel of parcels) {
    const target = published.parcelIds.has(normaliseParcelId(parcel)) ? matched : unmatched;
    target.add(parcel);
  }
  const matchedParcels = matched.size;
  const publishedParcelCount = published.parcelIds.size;

  /**
   * A run with thousands of parcels and no matches is not a finding about Seminole County, it
   * is a broken join key — which is exactly how this was found, having been reported as a
   * healthy `unmatchedParcels: 0`. Anything above a handful of parcels matching nothing is a
   * fault in this code, so it fails rather than being written down as a result.
   */
  if (parcels.size >= 100 && matchedParcels === 0) {
    throw new Error(
      `parcel join produced no matches for ${parcels.size} parcels against ` +
        `${publishedParcelCount} published — the join key spellings do not agree`,
    );
  }

  const summary: ReconcileCensusOutput = {
    runId: event.runId,
    shardsLanded: keys.length,
    rowsLanded,
    rowsFirstSeenThisRun,
    rowsConfirmedThisRun,
    distinctPermitRows: permitRows.size,
    distinctApplications: applications.size,
    distinctParcels: parcels.size,
    malformedParcelIds,
    roofingRows,
    emptyMonths,
    monthlyRows,
    parcelMatch: {
      snapshotRunId: published.snapshotRunId,
      publishedParcels: publishedParcelCount,
      matchedParcels,
      unmatchedParcels: unmatched.size,
      /** Share of *this run's* parcels that joined — the figure that says the join works. */
      joinRate: parcels.size === 0 ? 0 : Number((matchedParcels / parcels.size).toFixed(4)),
      /** Share of the published base this run touched. A slice touches very little. */
      coveredShareOfPublished:
        publishedParcelCount === 0 ? 0 : Number((matchedParcels / publishedParcelCount).toFixed(4)),
      unmatchedSamples: [...unmatched].slice(0, 20),
    },
    coverage: {
      ...COVERAGE,
      unincorporatedTouchRate: Number((matchedParcels / COVERAGE.unincorporatedParcels).toFixed(4)),
      countywideTouchRate: Number((matchedParcels / COVERAGE.countywideParcels).toFixed(4)),
    },
    summaryKey: censusSummaryKey(event.runId),
    coverageKey: coverageKey(event.runId),
  };

  await putJson(summary.summaryKey, summary);
  await putJson(summary.coverageKey, {
    runId: event.runId,
    runScope: event.scope,
    ...summary.coverage,
    matchedParcels,
    publishedParcels: publishedParcelCount,
    /**
     * Stated as a documented jurisdictional ceiling rather than a gap: the portal is the
     * county's own building-permit system and covers unincorporated land only. The seven
     * municipalities issue their own permits through their own systems, so no amount of
     * sweeping this source reaches them.
     */
    limitation:
      `The Building Public Request Portal covers ${COVERAGE.scope}: ` +
      `${COVERAGE.unincorporatedParcels} of ${COVERAGE.countywideParcels} parcels. ` +
      COVERAGE.note,
  });

  logger.info('Reconciled permit census', { summary });
  return summary;
}

export const handler = middy(baseHandler)
  .use(injectLambdaContext(logger))
  .use(captureLambdaHandler(tracer))
  .use(logMetrics(metrics));
