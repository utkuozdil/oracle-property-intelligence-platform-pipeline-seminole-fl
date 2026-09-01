/**
 * One Source A shard: every page of one application type over one calendar month.
 *
 * Raw HTML is written to S3 *before* anything is parsed out of it. That ordering is the
 * point — a parser bug, a changed column, or a new grid state costs a re-parse of objects
 * already in the bucket rather than a second crawl of a county web server.
 *
 * A shard is the unit of retry and the unit of idempotency. Its raw and per-run keys derive
 * entirely from `(runId, applicationType, month, page)`, so a redrive overwrites itself. The
 * accumulated month key is merged into rather than overwritten, and stays idempotent because
 * the merge is a set union on `rowKey`: re-running a shard re-merges rows already held and
 * changes nothing.
 */
import { injectLambdaContext } from '@aws-lambda-powertools/logger/middleware';
import { logMetrics } from '@aws-lambda-powertools/metrics/middleware';
import { captureLambdaHandler } from '@aws-lambda-powertools/tracer/middleware';
import middy from '@middy/core';
import { METRIC_ITEMS } from '@oracle-seminole/shared';
import { logger, metrics, tracer } from '../observability';
import { accumulateMonth, type MergeOutcome } from './census-union';
import { CensusShard, type CensusShardResult } from './model';
import { putNdjson, putText } from './objects';
import { CensusSession, sweepMonth } from './source-a';
import { censusMonthRowsKey, censusPageRawKey, censusRowsKey } from './storage';
import { summariseLatency } from './http';
import { recordVolume } from './work-metrics';

async function harvest(shard: CensusShard): Promise<CensusShardResult> {
  const session = new CensusSession();
  await session.open();
  logger.debug('Opened Source A session', { cookies: session.cookieNames() });

  const rawKeys: string[] = [];
  const query = {
    applicationType: shard.applicationType,
    periodStart: shard.periodStart,
    periodEnd: shard.periodEnd,
    month: shard.month,
  };

  const outcome = await sweepMonth(session, query, async ({ html, index }) => {
    const key = censusPageRawKey({
      runId: shard.runId,
      applicationType: shard.applicationType,
      month: shard.month,
      page: index,
    });
    await putText(key, html, 'text/html; charset=utf-8');
    rawKeys.push(key);
  });

  const parcels = new Set(outcome.rows.map((row) => row.parcelId).filter(Boolean));
  const roofingRows = outcome.rows.filter((row) => row.roofingRelevant).length;

  let rowsKey: string | null = null;
  let monthRowsKey: string | null = null;
  let merge: MergeOutcome = { rows: [], added: 0, updated: 0, carriedOver: 0, confirmed: 0 };

  if (outcome.rows.length > 0) {
    rowsKey = censusRowsKey({
      runId: shard.runId,
      applicationType: shard.applicationType,
      month: shard.month,
    });
    await putNdjson(rowsKey, outcome.rows);

    // The per-run key above is this sweep's own sample; the accumulated key below is the
    // dataset. Source A's pager returns a slightly different subset each time, so a sweep
    // may legitimately miss rows an earlier one found, and merging is what stops that
    // showing up as coverage going backwards.
    monthRowsKey = censusMonthRowsKey({
      applicationType: shard.applicationType,
      month: shard.month,
    });
    merge = await accumulateMonth(monthRowsKey, outcome.rows, shard.runId);
  }

  const result: CensusShardResult = {
    runId: shard.runId,
    applicationType: shard.applicationType,
    month: shard.month,
    state: outcome.state,
    statedTotal: outcome.statedTotal,
    statedPages: outcome.statedPages,
    pagesFetched: outcome.pagesFetched,
    rowsSeen: outcome.rowsSeen,
    rowsDeduped: outcome.rows.length,
    duplicateRows: outcome.rowsSeen - outcome.rows.length - outcome.malformedRows,
    distinctParcels: parcels.size,
    roofingRows,
    rowsKey,
    monthRowsKey,
    rowsNew: merge.added,
    rowsUpdated: merge.updated,
    rowsCarriedOver: merge.carriedOver,
    rowsAccumulated: merge.rows.length,
    rawKeys,
    latencyMs: summariseLatency(outcome.latencies),
    warnings: outcome.warnings,
  };

  logger.info('Harvested census shard', {
    ...result,
    // The raw keys are useful in the artifact but noise in a log line.
    rawKeys: rawKeys.length,
  });
  return result;
}

async function baseHandler(event: unknown): Promise<CensusShardResult> {
  const shard = CensusShard.parse(event);
  return recordVolume(
    METRIC_ITEMS.permit,
    () => harvest(shard),
    (result) => result.rowsDeduped,
  );
}

export const handler = middy(baseHandler)
  .use(injectLambdaContext(logger))
  .use(captureLambdaHandler(tracer))
  .use(logMetrics(metrics));
