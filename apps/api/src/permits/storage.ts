/**
 * S3 layout for the permit tier.
 *
 * Everything hangs off `permits/` inside the three prefixes the data bucket already owns,
 * so this tier adds no top-level prefix and inherits no lifecycle rule. In particular
 * `raw/permits/` is deliberately a sibling of `raw/expanded/` rather than a child: the
 * seven-day expiry on `raw/expanded/` matches a literal prefix, and raw permit HTML is
 * the thing that must outlive the parse.
 */
import { DATA_PREFIXES } from '@oracle-seminole/shared';

const PERMITS = 'permits/';

/** Raw Source A page HTML, written before anything is parsed out of it. */
export function censusPageRawKey(options: {
  runId: string;
  applicationType: string;
  month: string;
  page: number;
}): string {
  const page = String(options.page).padStart(4, '0');
  return (
    `${DATA_PREFIXES.raw}${PERMITS}source-a/type=${options.applicationType}/` +
    `month=${options.month}/run=${options.runId}/page-${page}.html`
  );
}

/** Everything the census tier writes, canonical and per-run alike. */
export const CENSUS_PREFIX = `${DATA_PREFIXES.staged}${PERMITS}census/`;

function censusShardPrefix(applicationType: string, month: string): string {
  return `${CENSUS_PREFIX}month=${month}/type=${applicationType}/`;
}

/** What this one run saw, kept for provenance and for run-over-run comparison. */
export function censusRowsKey(options: {
  runId: string;
  applicationType: string;
  month: string;
}): string {
  return `${censusShardPrefix(options.applicationType, options.month)}run=${options.runId}/rows.ndjson`;
}

/**
 * The accumulated union for one month and type — the dataset of record.
 *
 * Deliberately not run-scoped. Source A's pager is stateful and its row order varies between
 * identical queries, so one sweep of a month is a sample of that month rather than the whole
 * of it: repeated sweeps differ by ~0.13%. Writing each run's sample to its own key and
 * reading the newest made the row count oscillate. Merging every sweep into one key instead
 * means each re-harvest can only add, so coverage converges upward and stays there.
 */
export function censusMonthRowsKey(options: { applicationType: string; month: string }): string {
  return `${censusShardPrefix(options.applicationType, options.month)}rows.ndjson`;
}

/** Recognises the accumulated key, whose distinguishing feature is having no `run=` segment. */
export function isCensusMonthRowsKey(key: string): boolean {
  return key.startsWith(CENSUS_PREFIX) && key.endsWith('/rows.ndjson') && !key.includes('/run=');
}

/**
 * Derived roofing worklist. One object instead of re-reading every month shard to plan.
 * Not a month rows key (`…/rows.ndjson`), so the census walk never treats it as a shard.
 */
export function roofingCandidateIndexKey(): string {
  return `${CENSUS_PREFIX}index/roofing-candidates.ndjson`;
}

export function roofingCandidateIndexMetaKey(): string {
  return `${CENSUS_PREFIX}index/roofing-candidates.meta.json`;
}

/** Raw Source B HTML for one permit. `view` is `status` or `inspections`. */
export function statusRawKey(options: { runId: string; appNo: string; view: string }): string {
  return (
    `${DATA_PREFIXES.raw}${PERMITS}source-b/app=${options.appNo}/` +
    `run=${options.runId}/${options.view}.html`
  );
}

/** Every status record ever harvested, across runs. */
export const STATUS_PREFIX = `${DATA_PREFIXES.staged}${PERMITS}status/`;

/** Parsed status records for one Source B batch. */
export function statusRecordsKey(options: { runId: string; batchIndex: number }): string {
  const batch = String(options.batchIndex).padStart(4, '0');
  return `${STATUS_PREFIX}run=${options.runId}/batch-${batch}.ndjson`;
}

/**
 * The current long-open roofing leaderboard, at a stable key rather than a run-scoped one.
 *
 * A status record is a point-in-time observation and each run only observes part of the
 * population, so no single run's summary answers "which roofing permits are open longest".
 * That question is the one the CRM is built around, so the answer is reduced across every
 * pass ever run and published where a consumer can read it without knowing any run id.
 */
export function longOpenRoofingKey(): string {
  return `${DATA_PREFIXES.manifests}${PERMITS}long-open-roofing.json`;
}

function manifestPrefix(runId: string): string {
  return `${DATA_PREFIXES.manifests}${PERMITS}${runId}/`;
}

export function planKey(runId: string): string {
  return `${manifestPrefix(runId)}plan.json`;
}

/** Where the census Distributed Map's own result writer lands its per-shard output. */
export function censusMapResultsPrefix(runId: string): string {
  return `${manifestPrefix(runId)}census-map`;
}

export function statusMapResultsPrefix(runId: string): string {
  return `${manifestPrefix(runId)}status-map`;
}

export function censusSummaryKey(runId: string): string {
  return `${manifestPrefix(runId)}census-summary.json`;
}

export function statusSummaryKey(runId: string): string {
  return `${manifestPrefix(runId)}status-summary.json`;
}

export function coverageKey(runId: string): string {
  return `${manifestPrefix(runId)}coverage.json`;
}

/**
 * One batch of application numbers for Source B.
 *
 * The worklist is spilled to S3 and the Distributed Map iterates pointers rather than the
 * numbers themselves. A 24-month `ALL TYPES` window is tens of thousands of application
 * numbers, which would not fit in the 256 KB state payload.
 */
export function statusBatchKey(options: { runId: string; batchIndex: number }): string {
  const batch = String(options.batchIndex).padStart(4, '0');
  return `${manifestPrefix(options.runId)}status-batches/batch-${batch}.json`;
}

export function quarantineKey(options: { runId: string; batchIndex: number }): string {
  const batch = String(options.batchIndex).padStart(4, '0');
  return `${manifestPrefix(options.runId)}quarantine/batch-${batch}.json`;
}
