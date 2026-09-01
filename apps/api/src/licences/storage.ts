/**
 * S3 layout for the licence tier.
 *
 * Mirrors `src/bbb/storage.ts` key-for-key so a consumer that already reads one enrichment
 * tier can read this one without learning a second convention: everything hangs off
 * `licences/` inside prefixes the data bucket already owns, and the stable pointer sits at
 * the top of the staged prefix.
 */
import { DATA_PREFIXES } from '@oracle-seminole/shared';
import { createHash } from 'node:crypto';

const LICENCES = 'licences/';

/** Every licence in the county for a run, newline-delimited JSON. */
export function licencesKey(runId: string): string {
  return `${DATA_PREFIXES.staged}${LICENCES}seminole/run=${runId}/licences.ndjson`;
}

/**
 * The permit-contractor -> licence-standing join. This is what the UI and the CRM read.
 *
 * Named `contractor-licences` alongside BBB's `contractor-ratings`, because they are the same
 * kind of artifact about the same contractors and will be rendered side by side.
 */
export function contractorLicencesKey(runId: string): string {
  return `${DATA_PREFIXES.staged}${LICENCES}contractor-licences/run=${runId}/matches.ndjson`;
}

/**
 * Stable pointer to the newest completed run.
 *
 * Consumers read this one fixed key and follow it, so no reader lists prefixes or knows a
 * run id. Written **last**, after the run's own outputs, so it never points at a partial run.
 */
export function currentPointerKey(): string {
  return `${DATA_PREFIXES.staged}${LICENCES}contractor-licences/current.json`;
}

/** Licences in adverse standing, extracted for direct consumption by lead scoring. */
export function adverseLicencesKey(runId: string): string {
  return `${DATA_PREFIXES.staged}${LICENCES}adverse/run=${runId}/adverse.ndjson`;
}

function manifestPrefix(runId: string): string {
  return `${DATA_PREFIXES.manifests}${LICENCES}${runId}/`;
}

export function summaryKey(runId: string): string {
  return `${manifestPrefix(runId)}summary.json`;
}

/** Contractors that could not be joined, with their best candidate and score. */
export function unmatchedKey(runId: string): string {
  return `${manifestPrefix(runId)}unmatched.json`;
}

/**
 * The raw extract, kept only when a run asks for it.
 *
 * Off by default. The derived records carry `sourceUrl` and `fetchedAt`, and DBPR republishes
 * the file at least daily, so a 48.8 MB copy per scheduled run would add roughly 200 MB a
 * month to the bucket to preserve a snapshot nothing reads.
 */
export function rawExtractKey(runId: string): string {
  return `${DATA_PREFIXES.raw}${LICENCES}extract/run=${runId}/CONSTRUCTIONLICENSE_1.csv`;
}

/**
 * The idempotency ledger, keyed by source URL rather than by run.
 *
 * Deliberately outside any `run=` partition: its whole purpose is to be found by the *next*
 * run. The entry holds the derived county records rather than the 48.8 MB body, so a re-run
 * inside the freshness window costs one small `GetObject` instead of a 260-second download.
 */
export function ledgerKey(sourceUrl: string): string {
  const digest = createHash('sha256').update(sourceUrl).digest('hex');
  return `${DATA_PREFIXES.manifests}${LICENCES}ledger/${digest.slice(0, 2)}/${digest}.json`;
}
