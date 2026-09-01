/**
 * Reconciles the Source B pass, and raises the quarantine alert.
 *
 * Like the census reconciliation, this reads what landed in S3 rather than what the map
 * reported. It also owns the one operational signal this tier raises on its own: any
 * application status with no canonical mapping is published to the operations topic. Seven
 * status values were observed and the full enumeration is undocumented, so an unknown one is
 * a vocabulary change worth a human look — never something to bucket by guess.
 */
import { injectLambdaContext } from '@aws-lambda-powertools/logger/middleware';
import { logMetrics } from '@aws-lambda-powertools/metrics/middleware';
import { captureLambdaHandler } from '@aws-lambda-powertools/tracer/middleware';
import middy from '@middy/core';
import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import { COUNTY, DATA_PREFIXES } from '@oracle-seminole/shared';
import { logger, metrics, tracer } from '../observability';
import type { PermitStatusRecord, QuarantinedStatus } from './model';
import { getText, listKeys, listObjects, putJson } from './objects';
import { longOpenRoofingKey, statusSummaryKey, STATUS_PREFIX } from './storage';

const sns = new SNSClient({});

export interface ReconcileStatusInput {
  runId: string;
}

export interface ReconcileStatusOutput {
  runId: string;
  batchesLanded: number;
  permitsLanded: number;
  openPermits: number;
  closedPermits: number;
  withCloseDate: number;
  closedWithoutCloseDate: number;
  medianOpenDurationDays: number | null;
  statusCounts: Record<string, number>;
  quarantinedStatuses: string[];
  quarantinedPermits: number;
  openRoofingPermits: number;
  /** Open roofing permits past five years. The population the CRM is meant to work. */
  openRoofingPermitsOverFiveYears: number;
  /** The single longest-open roofing permit, or null when the run found none open. */
  oldestOpenRoofingPermit: LongOpenPermit | null;
  longestOpenRoofingPermits: LongOpenPermit[];
  longestOpenPermits: LongOpenPermit[];
  /** The same question answered across every pass ever run, not just this one. */
  dataset: DatasetLongOpen;
  summaryKey: string;
}

/**
 * The long-open picture across all runs.
 *
 * Needed because a status record is an observation rather than a fact and each run observes
 * only part of the population: an oldest-first pass and a newest-first pass produce summaries
 * that are each correct and neither of which answers the question the CRM asks. Reducing to
 * the newest observation per application does.
 */
export interface DatasetLongOpen {
  permitsKnown: number;
  runsReduced: number;
  openPermits: number;
  openRoofingPermits: number;
  openRoofingPermitsOverFiveYears: number;
  oldestOpenRoofingPermit: LongOpenPermit | null;
  longestOpenRoofingPermits: LongOpenPermit[];
  publishedKey: string;
}

/**
 * A still-open permit, ranked by how long it has been open.
 *
 * This is the tier's headline output rather than a convenience: "which roofing permits have
 * been open for years" is the question the dataset exists to answer, and computing it here
 * means the answer is a durable artifact of every run instead of an ad-hoc query.
 */
export interface LongOpenPermit {
  appNo: string;
  applicationDate: string | null;
  openDurationDays: number;
  openDurationYears: number;
  rawStatus: string;
  applicationType: string | null;
  address: string | null;
  parcelId: string | null;
  owner: string | null;
  generalContractor: string | null;
  roofingRelevant: boolean;
  inspectionCount: number;
  /** The most recent inspection result, which is the last time anything happened at all. */
  lastInspectionResultDate: string | null;
}

const LEADERBOARD_SIZE = 10;
const FIVE_YEARS_IN_DAYS = 5 * 365;

function toLongOpen(record: PermitStatusRecord): LongOpenPermit {
  const resultDates = record.inspections
    .map((inspection) => inspection.resultDate)
    .filter((date): date is string => date !== null)
    .sort();
  return {
    appNo: record.appNo,
    applicationDate: record.applicationDate,
    openDurationDays: record.openDurationDays ?? 0,
    openDurationYears: Number(((record.openDurationDays ?? 0) / 365.25).toFixed(1)),
    rawStatus: record.rawStatus,
    applicationType: record.applicationType,
    address: record.address,
    parcelId: record.parcelId,
    owner: record.owner,
    generalContractor: record.generalContractor,
    roofingRelevant: record.roofingRelevant,
    inspectionCount: record.inspections.length,
    lastInspectionResultDate: resultDates.at(-1) ?? null,
  };
}

/**
 * Longest-open first among permits still open with a known duration.
 *
 * `openDurationBasis` is what qualifies a record, not `terminal` alone: a permit whose status
 * is unmapped is not known to be open, and including it would put a quarantined record at the
 * top of the leaderboard on the strength of a status nobody has classified yet.
 */
export function rankLongestOpen(records: readonly PermitStatusRecord[]): LongOpenPermit[] {
  return records
    .filter((record) => record.openDurationBasis === 'still_open' && record.openDurationDays !== null)
    .sort((left, right) => (right.openDurationDays ?? 0) - (left.openDurationDays ?? 0))
    .map(toLongOpen);
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? null;
}

async function alertOnQuarantine(runId: string, statuses: readonly QuarantinedStatus[]): Promise<void> {
  const topicArn = process.env.OPERATIONS_TOPIC_ARN;
  if (!topicArn || statuses.length === 0) return;

  const distinct = [...new Set(statuses.map((entry) => entry.rawStatus))];
  await sns.send(
    new PublishCommand({
      TopicArn: topicArn,
      Subject: `${COUNTY} permits: ${distinct.length} unmapped permit status value(s)`,
      Message: [
        `Run ${runId} observed application statuses with no canonical mapping.`,
        '',
        'Unmapped values:',
        ...distinct.map((status) => `  - ${status}`),
        '',
        `Affected permits: ${statuses.length}`,
        'These permits were harvested and their raw HTML retained, but they carry',
        'canonicalStatus="unknown" and are excluded from the terminal-permit ledger, so',
        'they will be re-harvested until the mapping is extended.',
        '',
        'Add the value to PERMIT_STATUS_MAPPING in apps/api/src/permits/config.ts once its',
        'lifecycle is confirmed. Do not guess: a status wrongly marked terminal is never',
        'refreshed again.',
      ].join('\n'),
    }),
  );
}

/**
 * A staged status record, paired with when it was observed.
 *
 * `observedAt` is supplied by the caller from the S3 object's `LastModified` rather than read
 * off the record — see {@link reduceToCurrent} for why the record cannot supply it.
 */
export interface StatusObservation {
  record: PermitStatusRecord;
  /** The staged object's write time, as an ISO-8601 instant. */
  observedAt: string;
}

/**
 * The newest observation of each application, across every run.
 *
 * A permit's status changes, so unlike the census this is a last-writer-wins reduction rather
 * than a union: an older record saying `PERMIT ISSUED` must not outrank a newer one saying
 * `CLOSED`.
 *
 * Ordering is on the S3 object's `LastModified`, matching `reduceToCurrentObservation` in the
 * publish tier, which is deliberately one rule for the whole prefix rather than two. This used
 * to order on the record's own `harvestedAt`, and that was wrong in a way that inverted the
 * result: the field was added to the record type after the staged objects were written, so no
 * object in `staged/permits/status/` carries it. Every comparison therefore reduced to
 * `undefined > undefined`, false, and fell through to the run-id tiebreak — which is
 * lexicographic, so `verify-closed` (written 17:38) outranked `roof-hunt-r12` (written 18:39)
 * and each permit's *first* observed status was published as its current one. Records written
 * from now on do carry `harvestedAt`, which is precisely why it cannot be the ordering key: a
 * prefix where some records have it and some do not cannot be ordered by it at all.
 *
 * The run id still breaks ties, so two batches written in the same second reduce
 * deterministically.
 */
export function reduceToCurrent(observations: readonly StatusObservation[]): PermitStatusRecord[] {
  const current = new Map<string, StatusObservation>();
  for (const observation of observations) {
    const held = current.get(observation.record.appNo);
    const newer =
      !held ||
      observation.observedAt > held.observedAt ||
      (observation.observedAt === held.observedAt &&
        observation.record.runId > held.record.runId);
    if (newer) current.set(observation.record.appNo, observation);
  }
  return [...current.values()].map((observation) => observation.record);
}

/**
 * Every staged record under a prefix, each carrying its object's write time.
 *
 * An object with no `LastModified` is dated to the epoch rather than dropped: it is still a
 * real observation, and sorting it last means it can only lose to an object that has a date.
 */
async function readObservations(
  prefix: string,
): Promise<{ observations: StatusObservation[]; keys: string[] }> {
  const objects = await listObjects(prefix);
  const observations: StatusObservation[] = [];
  for (const object of objects) {
    const observedAt = object.lastModified ?? new Date(0).toISOString();
    for (const line of (await getText(object.key)).split('\n')) {
      if (line) {
        observations.push({ record: JSON.parse(line) as PermitStatusRecord, observedAt });
      }
    }
  }
  return { observations, keys: objects.map((object) => object.key) };
}

async function buildDatasetView(): Promise<DatasetLongOpen> {
  const { observations, keys } = await readObservations(STATUS_PREFIX);
  const current = reduceToCurrent(observations);
  const longestOpen = rankLongestOpen(current);
  const roofing = longestOpen.filter((permit) => permit.roofingRelevant);

  const runs = new Set(keys.map((key) => /run=([^/]+)/.exec(key)?.[1] ?? ''));
  const dataset: DatasetLongOpen = {
    permitsKnown: current.length,
    runsReduced: runs.size,
    openPermits: longestOpen.length,
    openRoofingPermits: roofing.length,
    openRoofingPermitsOverFiveYears: roofing.filter(
      (permit) => permit.openDurationDays >= FIVE_YEARS_IN_DAYS,
    ).length,
    oldestOpenRoofingPermit: roofing.at(0) ?? null,
    longestOpenRoofingPermits: roofing.slice(0, LEADERBOARD_SIZE),
    publishedKey: longOpenRoofingKey(),
  };

  await putJson(dataset.publishedKey, dataset);
  return dataset;
}

/** Exported so an operator sweep can reconcile and republish the leaderboard on its own. */
export async function reconcileStatusRun(
  event: ReconcileStatusInput,
): Promise<ReconcileStatusOutput> {
  const recordKeys = await listKeys(`${STATUS_PREFIX}run=${event.runId}/`);
  const records: PermitStatusRecord[] = [];
  for (const key of recordKeys) {
    for (const line of (await getText(key)).split('\n')) {
      if (line) records.push(JSON.parse(line) as PermitStatusRecord);
    }
  }

  const quarantineKeys = await listKeys(
    `${DATA_PREFIXES.manifests}permits/${event.runId}/quarantine/`,
  );
  const quarantined: QuarantinedStatus[] = [];
  for (const key of quarantineKeys) {
    quarantined.push(...(JSON.parse(await getText(key)) as QuarantinedStatus[]));
  }

  const statusCounts: Record<string, number> = {};
  for (const record of records) {
    statusCounts[record.rawStatus || '(blank)'] =
      (statusCounts[record.rawStatus || '(blank)'] ?? 0) + 1;
  }

  const closed = records.filter((record) => record.terminal);
  const longestOpen = rankLongestOpen(records);
  const longestOpenRoofing = longestOpen.filter((permit) => permit.roofingRelevant);

  const summary: ReconcileStatusOutput = {
    runId: event.runId,
    batchesLanded: recordKeys.length,
    permitsLanded: records.length,
    openPermits: records.filter((record) => !record.terminal).length,
    closedPermits: closed.length,
    withCloseDate: records.filter((record) => record.closedDate !== null).length,
    // Expected to be non-zero: Source B has no close-date field, so a resolved permit whose
    // inspections carry no result date has no derivable close date at all.
    closedWithoutCloseDate: closed.filter((record) => record.closedDate === null).length,
    medianOpenDurationDays: median(
      records
        .map((record) => record.openDurationDays)
        .filter((days): days is number => days !== null),
    ),
    statusCounts,
    quarantinedStatuses: [...new Set(quarantined.map((entry) => entry.rawStatus))],
    quarantinedPermits: quarantined.length,
    openRoofingPermits: longestOpenRoofing.length,
    openRoofingPermitsOverFiveYears: longestOpenRoofing.filter(
      (permit) => permit.openDurationDays >= FIVE_YEARS_IN_DAYS,
    ).length,
    oldestOpenRoofingPermit: longestOpenRoofing.at(0) ?? null,
    longestOpenRoofingPermits: longestOpenRoofing.slice(0, LEADERBOARD_SIZE),
    longestOpenPermits: longestOpen.slice(0, LEADERBOARD_SIZE),
    dataset: await buildDatasetView(),
    summaryKey: statusSummaryKey(event.runId),
  };

  await putJson(summary.summaryKey, summary);
  await alertOnQuarantine(event.runId, quarantined);

  logger.info('Reconciled permit status sweep', { summary });
  return summary;
}

export const handler = middy(reconcileStatusRun)
  .use(injectLambdaContext(logger))
  .use(captureLambdaHandler(tracer))
  .use(logMetrics(metrics));
