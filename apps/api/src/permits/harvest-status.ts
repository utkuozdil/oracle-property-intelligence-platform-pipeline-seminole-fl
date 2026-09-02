/**
 * One Source B batch: status and open duration for a list of application numbers.
 *
 * This function is pinned to one concurrent execution by the stack, and the in-process
 * limiter below is what actually paces the portal. That split matters: a Distributed Map's
 * `MaxConcurrency` bounds how many workers run, not how fast they ask, and an F5 ASM cares
 * about the second number. With reserved concurrency at 1 and the limiter at 3, the portal
 * sees at most three requests in flight from this account, whatever the map does.
 *
 * As with the census, raw HTML lands in S3 before it is parsed.
 */
import { injectLambdaContext } from '@aws-lambda-powertools/logger/middleware';
import { logMetrics } from '@aws-lambda-powertools/metrics/middleware';
import { captureLambdaHandler } from '@aws-lambda-powertools/tracer/middleware';
import middy from '@middy/core';
import { METRIC_ITEMS } from '@oracle-seminole/shared';
import { z } from 'zod';
import { logger, metrics, tracer } from '../observability';
import { mapStatus, normalizeStatus, SOURCE_B_CONCURRENCY, SOURCE_B_DELAY_MS } from './config';
import { staticFormFields } from './html';
import { mapWithConcurrency, summariseLatency } from './http';
import { recordPermitStatuses, terminalPermits, type LedgerEntry } from './ledger';
import {
  StatusBatch,
  StatusWorkItem,
  type PermitStatusRecord,
  type QuarantinedStatus,
  type StatusBatchResult,
} from './model';
import { getJson, getTextIfPresent, putJson, putNdjson, putText } from './objects';
import { buildStatusRecord, fetchInspections, fetchStatusDetail } from './source-b';
import { quarantineKey, statusProgressKey, statusRawKey, statusRecordsKey } from './storage';
import { recordVolume } from './work-metrics';

interface HarvestedPermit {
  record: PermitStatusRecord;
  unmappedStatus: string | null;
  latencyMs: number;
}

async function harvestOne(
  runId: string,
  item: StatusWorkItem,
  now: Date,
): Promise<HarvestedPermit> {
  const { appNo } = item;
  const detail = await fetchStatusDetail(appNo);
  const detailKey = statusRawKey({ runId, appNo, view: 'status' });
  await putText(detailKey, detail.html, 'text/html; charset=ISO-8859-1');

  /**
   * Skip the inspections GET once the status page already says the permit is terminal.
   *
   * The close date then stays null — Source B has no close field on the status page — which
   * is honest for a CRM that filters on open / long-open, not on historical close dates.
   * Open and unmapped statuses still fetch inspections: those rows are the stalled-job
   * signal, and a permit can have its final inspection approved before the status flips.
   */
  const rawStatus = normalizeStatus(staticFormFields(detail.html).Application ?? '');
  const alreadyTerminal = mapStatus(rawStatus)?.terminal === true;
  const inspections = alreadyTerminal
    ? null
    : await fetchInspections(detail.jar, detail.csrfToken);
  let inspectionsKey: string | null = null;
  if (inspections) {
    inspectionsKey = statusRawKey({ runId, appNo, view: 'inspections' });
    await putText(inspectionsKey, inspections.html, 'text/html; charset=ISO-8859-1');
  }

  const complete = buildStatusRecord({
    runId,
    appNo,
    statusHtml: detail.html,
    inspectionsHtml: inspections?.html ?? null,
    statusRawKey: detailKey,
    inspectionsRawKey: inspectionsKey,
    now,
    roofingRelevant: item.roofing,
    roofingMatchedBy: item.roofingMatchedBy,
    censusIssuedOn: item.censusIssuedOn,
  });
  return { ...complete, latencyMs: detail.durationMs + (inspections?.durationMs ?? 0) };
}

/**
 * Exported so a long sweep can be driven batch-by-batch from an operator process as well as by
 * the Distributed Map. Both callers get the same in-process rate limiter, which is where this
 * tier's politeness actually lives — see the note on {@link SOURCE_B_CONCURRENCY}.
 */
async function recordStatusProgress(
  batch: StatusBatch,
  harvestedThisBatch: number,
  now: Date,
): Promise<void> {
  const key = statusProgressKey(batch.runId);
  const previous = await getTextIfPresent(key);
  let priorLanded = 0;
  let priorBatches = 0;
  if (previous.body !== null && previous.body !== '') {
    try {
      const parsed = JSON.parse(previous.body) as {
        permitsLanded?: number;
        batchesLanded?: number;
      };
      priorLanded = Number(parsed.permitsLanded) || 0;
      priorBatches = Number(parsed.batchesLanded) || 0;
    } catch {
      priorLanded = 0;
      priorBatches = 0;
    }
  }
  await putJson(key, {
    runId: batch.runId,
    updatedAt: now.toISOString(),
    lastBatchIndex: batch.batchIndex,
    permitsLanded: priorLanded + harvestedThisBatch,
    batchesLanded: priorBatches + 1,
  });
}

/** Default is {@link SOURCE_B_CONCURRENCY} (3). Local probes may raise it via env. */
function sourceBConcurrency(): number {
  const raw = process.env.SOURCE_B_CONCURRENCY;
  if (raw === undefined || raw === '') return SOURCE_B_CONCURRENCY;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : SOURCE_B_CONCURRENCY;
}

export async function harvestStatusBatch(batch: StatusBatch): Promise<StatusBatchResult> {
  const items = z.array(StatusWorkItem).parse(await getJson(batch.batchKey));
  const now = new Date();

  const alreadyTerminal = await terminalPermits(items.map((item) => item.appNo));
  const pending = items.filter((item) => !alreadyTerminal.has(item.appNo));

  const concurrency = sourceBConcurrency();
  const harvested = await mapWithConcurrency(pending, concurrency, SOURCE_B_DELAY_MS, (item) =>
    harvestOne(batch.runId, item, now),
  );

  const records = harvested.map((item) => item.record);
  const quarantined: QuarantinedStatus[] = harvested
    .filter((item) => item.unmappedStatus !== null)
    .map((item) => ({
      appNo: item.record.appNo,
      rawStatus: item.unmappedStatus as string,
      observedAt: now.toISOString(),
      statusRawKey: item.record.statusRawKey,
    }));

  let recordsKey: string | null = null;
  if (records.length > 0) {
    recordsKey = statusRecordsKey({ runId: batch.runId, batchIndex: batch.batchIndex });
    await putNdjson(recordsKey, records);
  }
  if (quarantined.length > 0) {
    await putJson(quarantineKey({ runId: batch.runId, batchIndex: batch.batchIndex }), quarantined);
  }

  /**
   * Every permit with a mapped status is recorded, terminal or not, and `terminal` is recorded
   * as what it actually is.
   *
   * `terminalPermits` filters on `terminal === true`, so writing open permits here cannot make
   * one skipped permanently — but it does give the planner a `lastHarvestedAt` to skip a *recent*
   * observation against, which is what makes a tranched sweep advance instead of re-fetching its
   * own open permits. Without it the ledger only ever remembers closed permits, and the open ones
   * this tier exists to find are the ones it forgets.
   *
   * An unmapped status is still recorded as nothing at all, so quarantining a permit never also
   * freezes it: it stays re-harvestable until the mapping is extended.
   */
  const ledger: LedgerEntry[] = records
    .filter((record) => record.canonicalStatus !== 'unknown')
    .map((record) => ({
      appNo: record.appNo,
      rawStatus: record.rawStatus,
      canonicalStatus: record.canonicalStatus,
      terminal: record.terminal,
      closedDate: record.closedDate,
      lastHarvestedAt: now.toISOString(),
      runId: batch.runId,
    }));
  await recordPermitStatuses(ledger);
  await recordStatusProgress(batch, records.length, now);

  const result: StatusBatchResult = {
    runId: batch.runId,
    batchIndex: batch.batchIndex,
    permitsRequested: items.length,
    permitsHarvested: records.length,
    permitsSkippedTerminal: items.length - pending.length,
    openPermits: records.filter((record) => !record.terminal).length,
    closedPermits: records.filter((record) => record.terminal).length,
    withCloseDate: records.filter((record) => record.closedDate !== null).length,
    quarantined,
    recordsKey,
    latencyMs: summariseLatency(harvested.map((item) => item.latencyMs)),
    warnings:
      quarantined.length > 0
        ? [`${quarantined.length} permits carried an unmapped application status`]
        : [],
  };

  logger.info('Harvested status batch', { result });
  return result;
}

async function baseHandler(event: unknown): Promise<StatusBatchResult> {
  const batch = StatusBatch.parse(event);
  return recordVolume(
    METRIC_ITEMS.permit,
    () => harvestStatusBatch(batch),
    (result) => result.permitsHarvested,
  );
}

export const handler = middy(baseHandler)
  .use(injectLambdaContext(logger))
  .use(captureLambdaHandler(tracer))
  .use(logMetrics(metrics));
