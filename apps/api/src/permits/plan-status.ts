/**
 * Builds the Source B worklist from the census that just landed.
 *
 * Source B can only be enumerated through Source A's application numbers, so this reads the
 * census rows out of S3 and derives the list. It is also where the request budget is
 * actually spent or saved: the window is bounded, permits already known terminal are
 * dropped, and the remainder is ordered so the most decision-relevant permits are harvested
 * first if the limit truncates the list.
 *
 * The worklist is spilled to S3 in batches and the state machine iterates pointers. Tens of
 * thousands of application numbers do not fit in a 256 KB state payload.
 */
import { injectLambdaContext } from '@aws-lambda-powertools/logger/middleware';
import { logMetrics } from '@aws-lambda-powertools/metrics/middleware';
import { captureLambdaHandler } from '@aws-lambda-powertools/tracer/middleware';
import middy from '@middy/core';
import { logger, metrics, tracer } from '../observability';
import {
  ROOFING_DESCRIPTION_PATTERN,
  ROOFING_PERMIT_TYPE_CODES,
} from './config';
import {
  fingerprintMonthShards,
  loadRoofingCandidateIndex,
  saveRoofingCandidateIndex,
  type RoofingCandidateRecord,
} from './candidate-index';
import { observedPermits, terminalPermits } from './ledger';
import type { CensusRow, RoofingMatchRule, StatusBatch, StatusWorkItem } from './model';
import { getText, listObjects, putJson } from './objects';
import { permitTypeCodeOf } from './source-a';
import { CENSUS_PREFIX, isCensusMonthRowsKey, statusBatchKey } from './storage';

/** Our S3, not the portal — parallel month reads only when the index is missing. */
const SHARD_READ_CONCURRENCY = 16;

/** ~200 permits per invocation at 2.3 s each is ~8 minutes, well inside the 15-minute ceiling. */
export const STATUS_BATCH_SIZE = 150;

/** How far ahead the ledger is probed while filling the worklist. Five BatchGetItem calls. */
const LEDGER_PROBE_CHUNK = 500;

/**
 * Sentinel used to sort applications whose issue date would not parse.
 *
 * Day 99 does not exist, so it sorts after every real date in the same month while keeping the
 * application in the worklist rather than dropping it. It is a sort key and never a date, so it
 * has to be stripped everywhere a date is reported or written.
 */
const UNPARSEABLE_DAY = '-99';

function realDateOrNull(sortKey: string): string | null {
  return /^\d{4}-\d{2}-\d{2}$/.test(sortKey) && !sortKey.endsWith(UNPARSEABLE_DAY) ? sortKey : null;
}

export interface PlanStatusInput {
  runId: string;
  scope: {
    statusFromMonth: string;
    statusPermitLimit: number;
    /**
     * Which end of the worklist survives truncation. `newest` keeps the recent population,
     * where an open permit is a live operational signal. `oldest` keeps the deep history,
     * which is where a permit that has been open for decades can be found at all.
     */
    statusOrder: 'newest' | 'oldest';
    /** Restrict the worklist to applications with at least one roofing row. */
    statusRoofingOnly: boolean;
    /**
     * How long an existing observation of a non-terminal permit is considered current.
     *
     * The terminal ledger alone cannot make a sweep resumable across tranches, and the gap is
     * exactly the population this tier cares about. A closed permit is skipped forever, but an
     * *open* one is not in the terminal ledger at all, so a second run re-selects it — and
     * since open permits cluster at the oldest end of an oldest-first ordering, each tranche
     * would spend its budget re-fetching the previous tranche's leads instead of advancing.
     * Measured on the exploratory runs, 13.7% of checked applications were open.
     *
     * Zero re-fetches every non-terminal permit, which is what a deliberate refresh pass wants.
     */
    statusRefreshDays: number;
  };
}

export interface PlanStatusOutput {
  runId: string;
  batches: StatusBatch[];
  candidates: number;
  skippedTerminal: number;
  /** Non-terminal permits observed inside the freshness window, so a re-run advances. */
  skippedFresh: number;
  skippedOutOfWindow: number;
  skippedNonRoofing: number;
  /** How many selected applications each roofing rule claimed. Rules overlap, so these sum high. */
  roofingRuleCounts: Record<RoofingMatchRule, number>;
  truncated: boolean;
  selected: number;
  /** How far down the ordered candidate list the ledger walk reached. */
  candidatesExamined: number;
  order: 'newest' | 'oldest';
  /** The issue-date span actually selected, so truncation is visible rather than implied. */
  selectedFrom: string | null;
  selectedTo: string | null;
  /** `index` means the census was not re-downloaded. */
  candidateSource: 'index' | 'census-rebuild';
}

/** What the census says about one application, collapsed from its several grid rows. */
interface Candidate {
  /** Oldest and newest age key across the application's rows. See {@link rowAgeKey}. */
  earliestAge: string;
  latestAge: string;
  roofing: boolean;
  roofingMatchedBy: Set<RoofingMatchRule>;
  /** Earliest issue date that survived the trust check, for reporting rather than ordering. */
  earliestTrustedIssue: string | null;
  earliestMonth: string;
}

/**
 * Which roofing vocabularies claim one census row.
 *
 * Three rules over two independent type columns plus the free text, because measured over the
 * full census they disagree: `permit_type` finds 17,933 applications no description code marks,
 * and `application_type` — the census's own `roofingRelevant` — finds 55,718. Taking the union
 * and recording the provenance is what makes the disagreement visible instead of a judgement
 * call buried in a filter.
 */
export function roofingRulesForRow(row: CensusRow): RoofingMatchRule[] {
  const rules: RoofingMatchRule[] = [];
  const permitTypeCode = permitTypeCodeOf(row.permitType ?? '');
  if (permitTypeCode !== null && ROOFING_PERMIT_TYPE_CODES.has(permitTypeCode)) {
    rules.push('permit_type');
  }
  // The census already applied the description-code vocabulary; re-deriving it here would be a
  // second opinion on a field that is the census's to own.
  if (row.roofingRelevant) rules.push('application_type');
  if (ROOFING_DESCRIPTION_PATTERN.test(row.description ?? '')) rules.push('description');
  return rules;
}

/**
 * How old one census row is, as a sortable string.
 *
 * `issuedOn` is used only when it falls inside the month shard the row was harvested from, and
 * the shard month is used otherwise. That is not belt-and-braces: 29,487 census rows (7.88%)
 * carry an issue date outside their shard, clustered on two-digit years that resolve to 1930,
 * 1931, 1940, 1941 and so on up the decades — `2-10436` reads `10/3/30` in the 2003-01 shard.
 * Ordering oldest-first on the raw field puts 1,859 applications with fabricated 1930s-1980s
 * dates at the head of the sweep, ahead of every genuinely old permit, which defeats the only
 * reason to sweep oldest-first at all.
 *
 * The shard month is trustworthy because it is the query window the row was retrieved through
 * rather than a value parsed out of the response.
 */
export function rowAgeKey(row: Pick<CensusRow, 'issuedOn' | 'month'>): string {
  const issue = row.issuedOn;
  if (issue && /^\d{4}-\d{2}-\d{2}$/.test(issue) && issue.slice(0, 7) === row.month) return issue;
  return `${row.month}${UNPARSEABLE_DAY}`;
}

/** Exported so an operator sweep can plan a worklist without standing up the state machine. */
function foldCensusText(body: string, byAppNo: Map<string, Candidate>, fromMonth: string): number {
  let skippedOutOfWindow = 0;
  for (const line of body.split('\n')) {
    if (!line) continue;
    const row = JSON.parse(line) as CensusRow;
    if (!row.appNo) continue;
    if (row.month < fromMonth) {
      skippedOutOfWindow += 1;
      continue;
    }
    const age = rowAgeKey(row);
    const trustedIssue = age.endsWith(UNPARSEABLE_DAY) ? null : age;
    const rules = roofingRulesForRow(row);
    const held = byAppNo.get(row.appNo);
    if (!held) {
      byAppNo.set(row.appNo, {
        earliestAge: age,
        latestAge: age,
        roofing: rules.length > 0,
        roofingMatchedBy: new Set(rules),
        earliestTrustedIssue: trustedIssue,
        earliestMonth: row.month,
      });
      continue;
    }
    if (age < held.earliestAge) held.earliestAge = age;
    if (age > held.latestAge) held.latestAge = age;
    if (row.month < held.earliestMonth) held.earliestMonth = row.month;
    if (trustedIssue && (held.earliestTrustedIssue === null || trustedIssue < held.earliestTrustedIssue)) {
      held.earliestTrustedIssue = trustedIssue;
    }
    for (const rule of rules) held.roofingMatchedBy.add(rule);
    held.roofing = held.roofing || rules.length > 0;
  }
  return skippedOutOfWindow;
}

async function readShardsParallel(keys: readonly string[]): Promise<string[]> {
  const results = new Array<string>(keys.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= keys.length) return;
      results[index] = await getText(keys[index] as string);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(SHARD_READ_CONCURRENCY, keys.length) }, () => worker()),
  );
  return results;
}

function recordsFromMap(byAppNo: Map<string, Candidate>): RoofingCandidateRecord[] {
  const records: RoofingCandidateRecord[] = [];
  for (const [appNo, candidate] of byAppNo) {
    if (!candidate.roofing) continue;
    records.push({
      appNo,
      earliestAge: candidate.earliestAge,
      latestAge: candidate.latestAge,
      roofingMatchedBy: [...candidate.roofingMatchedBy].sort(),
      earliestTrustedIssue: candidate.earliestTrustedIssue,
      earliestMonth: candidate.earliestMonth,
    });
  }
  return records;
}

function mapFromRecords(records: readonly RoofingCandidateRecord[]): Map<string, Candidate> {
  const byAppNo = new Map<string, Candidate>();
  for (const record of records) {
    byAppNo.set(record.appNo, {
      earliestAge: record.earliestAge,
      latestAge: record.latestAge,
      roofing: true,
      roofingMatchedBy: new Set(record.roofingMatchedBy),
      earliestTrustedIssue: record.earliestTrustedIssue,
      earliestMonth: record.earliestMonth,
    });
  }
  return byAppNo;
}

export async function planStatusSweep(event: PlanStatusInput): Promise<PlanStatusOutput> {
  const objects = await listObjects(CENSUS_PREFIX);
  const monthKeys = objects.map((object) => object.key).filter(isCensusMonthRowsKey);
  const fingerprint = fingerprintMonthShards(objects);
  const cached = event.scope.statusRoofingOnly
    ? await loadRoofingCandidateIndex(fingerprint)
    : { records: [], allApplications: 0, fingerprint, source: 'missing' as const };

  /** One request per *application*, not per grid row: several rows share an application. */
  let byAppNo = new Map<string, Candidate>();
  let skippedOutOfWindow = 0;
  let candidateSource: PlanStatusOutput['candidateSource'] = 'census-rebuild';

  if (cached.source === 'index') {
    byAppNo = mapFromRecords(cached.records);
    candidateSource = 'index';
    const fromMonth = event.scope.statusFromMonth;
    const stale: string[] = [];
    for (const [appNo, candidate] of byAppNo) {
      if (candidate.latestAge.slice(0, 7) < fromMonth) stale.push(appNo);
    }
    for (const appNo of stale) {
      byAppNo.delete(appNo);
      skippedOutOfWindow += 1;
    }
    logger.info('Planned from roofing candidate index', {
      records: cached.records.length,
      afterWindow: byAppNo.size,
      fromMonth,
      fingerprint,
    });
  } else {
    const bodies = await readShardsParallel(monthKeys);
    for (const body of bodies) {
      skippedOutOfWindow += foldCensusText(body, byAppNo, event.scope.statusFromMonth);
    }
    if (event.scope.statusRoofingOnly) {
      await saveRoofingCandidateIndex({
        records: recordsFromMap(byAppNo),
        allApplications: byAppNo.size,
        fingerprint,
      });
    }
  }

  const allCandidates = [...byAppNo.keys()];
  const inScope = event.scope.statusRoofingOnly
    ? allCandidates.filter((appNo) => byAppNo.get(appNo)?.roofing === true)
    : allCandidates;
  const skippedNonRoofing =
    cached.source === 'index'
      ? Math.max(0, cached.allApplications - inScope.length)
      : allCandidates.length - inScope.length;

  const oldest = event.scope.statusOrder === 'oldest';
  const sortKey = (appNo: string): string => {
    const candidate = byAppNo.get(appNo);
    return (oldest ? candidate?.earliestAge : candidate?.latestAge) ?? '';
  };
  const ordered = [...inScope].sort((left, right) => {
    const comparison = oldest
      ? sortKey(left).localeCompare(sortKey(right))
      : sortKey(right).localeCompare(sortKey(left));
    // Application number breaks the tie so a resumed run walks the list in the same order it
    // walked before. Thousands of applications share a month-only age key, and an unstable
    // order there would make the freshness skip re-plan a different slice each time.
    return comparison !== 0 ? comparison : left.localeCompare(right);
  });

  /**
   * Sort first, then consult the ledger only as deep into the list as the limit requires.
   *
   * The ledger is now asked about the whole accumulated dataset rather than one run's rows,
   * which is hundreds of thousands of applications. Checking all of them costs one BatchGetItem
   * per hundred keys to establish facts about permits the limit was never going to reach.
   * Walking the sorted list instead bounds the reads by the limit and the terminal rate.
   */
  const selected: string[] = [];
  let skippedTerminal = 0;
  let skippedFresh = 0;
  let examined = 0;
  const freshnessCutoff = new Date(
    Date.now() - event.scope.statusRefreshDays * 24 * 60 * 60 * 1000,
  ).toISOString();

  for (
    let offset = 0;
    offset < ordered.length && selected.length < event.scope.statusPermitLimit;
    offset += LEDGER_PROBE_CHUNK
  ) {
    const window = ordered.slice(offset, offset + LEDGER_PROBE_CHUNK);
    const [terminal, observed] = await Promise.all([
      terminalPermits(window),
      observedPermits(window),
    ]);
    for (const appNo of window) {
      examined += 1;
      if (terminal.has(appNo)) {
        skippedTerminal += 1;
        continue;
      }
      const lastObserved = observed.get(appNo);
      if (lastObserved !== undefined && lastObserved > freshnessCutoff) {
        skippedFresh += 1;
        continue;
      }
      selected.push(appNo);
      if (selected.length >= event.scope.statusPermitLimit) break;
    }
  }

  // Reported dates exclude the sentinel, so a span reads `1999-08-16..2004-03` rather than
  // `1999-08-16..2004-03-99`, which is not a date and reads as a parsing fault.
  const selectedDates = selected
    .map((appNo) => realDateOrNull(sortKey(appNo)))
    .filter((date): date is string => date !== null)
    .sort();

  const workItems: StatusWorkItem[] = selected.map((appNo) => {
    const candidate = byAppNo.get(appNo);
    return {
      appNo,
      roofing: candidate?.roofing ?? false,
      roofingMatchedBy: [...(candidate?.roofingMatchedBy ?? [])].sort(),
      censusIssuedOn: candidate?.earliestTrustedIssue ?? null,
      censusMonth: candidate?.earliestMonth ?? '1996-01',
    };
  });

  const batches: StatusBatch[] = [];
  for (let index = 0; index * STATUS_BATCH_SIZE < workItems.length; index += 1) {
    const slice = workItems.slice(index * STATUS_BATCH_SIZE, (index + 1) * STATUS_BATCH_SIZE);
    const batchKey = statusBatchKey({ runId: event.runId, batchIndex: index });
    await putJson(batchKey, slice);
    batches.push({
      runId: event.runId,
      batchKey,
      batchIndex: index,
      permitCount: slice.length,
    });
  }

  const output: PlanStatusOutput = {
    runId: event.runId,
    batches,
    candidates: inScope.length,
    /** Terminal permits met while filling the worklist, not across the whole population. */
    skippedTerminal,
    skippedFresh,
    skippedOutOfWindow,
    skippedNonRoofing,
    roofingRuleCounts: {
      permit_type: workItems.filter((item) => item.roofingMatchedBy.includes('permit_type')).length,
      application_type: workItems.filter((item) =>
        item.roofingMatchedBy.includes('application_type'),
      ).length,
      description: workItems.filter((item) => item.roofingMatchedBy.includes('description')).length,
    },
    /** The limit stopped the walk before the candidate list was exhausted. */
    truncated: examined < ordered.length,
    selected: selected.length,
    candidatesExamined: examined,
    order: event.scope.statusOrder,
    selectedFrom: selectedDates.at(0) ?? null,
    selectedTo: selectedDates.at(-1) ?? null,
    candidateSource,
  };

  logger.info('Planned Source B status sweep', { ...output, batches: batches.length });
  return output;
}

export const handler = middy(planStatusSweep)
  .use(injectLambdaContext(logger))
  .use(captureLambdaHandler(tracer))
  .use(logMetrics(metrics));
