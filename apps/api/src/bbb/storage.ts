/**
 * S3 layout for the BBB tier.
 *
 * Everything hangs off `bbb/` inside the prefixes the data bucket already owns, so this
 * tier adds no top-level prefix. `raw/bbb/` is a sibling of `raw/expanded/` rather than a
 * child, for the same reason `raw/permits/` is: the seven-day expiry on `raw/expanded/`
 * matches a literal prefix, and the raw HTML has to outlive the parse.
 */
import { DATA_PREFIXES } from '@oracle-seminole/shared';
import { createHash } from 'node:crypto';

const BBB = 'bbb/';

/** A filesystem- and S3-safe slug. */
export function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'none'
  );
}

/**
 * Search terms become part of a key, and a contractor name can be long, punctuated, and
 * near-identical to another. A short hash keeps keys bounded and unique; the readable slug
 * stays in front of it so a key is still greppable by eye.
 */
export function termKey(term: string): string {
  const digest = createHash('sha256').update(term).digest('hex').slice(0, 10);
  return `${slug(term)}-${digest}`;
}

/** Raw search-response HTML, written before anything is parsed out of it. */
export function searchPageRawKey(options: {
  runId: string;
  location: string;
  term: string;
  page: number;
}): string {
  const page = String(options.page).padStart(4, '0');
  return (
    `${DATA_PREFIXES.raw}${BBB}search/loc=${slug(options.location)}/` +
    `term=${termKey(options.term)}/run=${options.runId}/page-${page}.html`
  );
}

/** Every distinct business harvested by a run, newline-delimited JSON. */
export function businessesKey(runId: string): string {
  return `${DATA_PREFIXES.staged}${BBB}businesses/run=${runId}/businesses.ndjson`;
}

/** The permit-contractor -> BBB-rating join. This is what the UI and the CRM read. */
export function contractorRatingsKey(runId: string): string {
  return `${DATA_PREFIXES.staged}${BBB}contractor-ratings/run=${runId}/matches.ndjson`;
}

/**
 * A stable pointer to the newest completed run, mirroring `publish/current.json`.
 *
 * Consumers read this one fixed key and follow it, so no reader has to list prefixes or
 * know a run id. Written last, after the run's own outputs, so it never points at a
 * partial run.
 */
export function currentPointerKey(): string {
  return `${DATA_PREFIXES.staged}${BBB}contractor-ratings/current.json`;
}

function manifestPrefix(runId: string): string {
  return `${DATA_PREFIXES.manifests}${BBB}${runId}/`;
}

export function summaryKey(runId: string): string {
  return `${manifestPrefix(runId)}summary.json`;
}

/** Contractors that could not be joined, with their best candidate and score. */
export function unmatchedKey(runId: string): string {
  return `${manifestPrefix(runId)}unmatched.json`;
}

/**
 * The idempotency ledger, keyed by search URL rather than by run.
 *
 * Deliberately outside any `run=` partition: its whole purpose is to be found by the
 * *next* run. Each entry holds the parsed records for that search, so a re-run triggered by
 * newly landed permits pays only for the contractors it has not looked up before.
 */
export function ledgerKey(searchUrl: string): string {
  const digest = createHash('sha256').update(searchUrl).digest('hex');
  return `${DATA_PREFIXES.manifests}${BBB}ledger/${digest.slice(0, 2)}/${digest}.json`;
}
