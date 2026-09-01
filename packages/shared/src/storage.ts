/**
 * Layout of the pipeline data bucket. The four prefixes are provisioned in Phase 0 and
 * are the contract between the TypeScript serving tier and the Python Glue tier.
 */
export const DATA_PREFIXES = {
  /** Untransformed source captures, exactly as retrieved. */
  raw: 'raw/',
  /** Normalised, transform-validated records awaiting reconciliation. */
  staged: 'staged/',
  /** Artifacts eligible for publication to Elephant IPFS. */
  publish: 'publish/',
  /** Per-run manifests: source list, record counts, deltas, timestamps. */
  manifests: 'manifests/',
} as const;

export type DataPrefix = (typeof DATA_PREFIXES)[keyof typeof DATA_PREFIXES];

export function runManifestKey(runId: string): string {
  return `${DATA_PREFIXES.manifests}${runId}/manifest.json`;
}

export function rawCaptureKey(runId: string, source: string, parcelId: string): string {
  return `${DATA_PREFIXES.raw}${runId}/${source}/${parcelId}.json`;
}

/**
 * The downloaded archive, and the CSVs expanded out of it, live under sibling prefixes
 * rather than together under `raw/<runId>/`.
 *
 * They have different lifetimes. The 95 MB archive is the provenance record — the exact
 * bytes the county served — and is worth keeping. The 640 MB of CSVs expanded from it are
 * a derivable intermediate, reproducible from the archive at any time, and keeping them
 * costs seven times as much as the thing they came from.
 *
 * S3 lifecycle filters match on a literal prefix with no wildcard, so a per-run layout
 * like `raw/<runId>/cama/` could not be targeted by a rule. Hoisting the discriminator
 * above the run id is what makes `raw/expanded/` expressible as a single rule.
 */
export const RAW_ARCHIVE_PREFIX = `${DATA_PREFIXES.raw}archive/`;
export const RAW_EXPANDED_PREFIX = `${DATA_PREFIXES.raw}expanded/`;

/**
 * Raw FDOR windows, and the pointer at the snapshot the transform should read.
 *
 * A third sibling under `raw/` for the same reason as the other two: it has its own
 * lifetime. FDOR publishes once a year, so a snapshot landed in August has to still be
 * there in July — it is the *current* second source, not an intermediate. Neither
 * `ExpireExpandedCsvs` nor the archive expiry may reach it, which is exactly what a
 * distinct literal prefix guarantees.
 */
export const RAW_FDOR_PREFIX = `${DATA_PREFIXES.raw}fdor/`;

export function fdorSnapshotPrefix(runId: string): string {
  return `${RAW_FDOR_PREFIX}${runId}/`;
}

export function fdorWindowKey(runId: string, windowIndex: number): string {
  return `${fdorSnapshotPrefix(runId)}window-${String(windowIndex).padStart(4, '0')}.json`;
}

/**
 * Stable pointer to the FDOR snapshot in force.
 *
 * The CAMA archive is re-downloaded nightly, so the transform can always name its own
 * run's archive. FDOR is annual, so on all but one night a year the run has no snapshot
 * of its own and must be told which previous run's snapshot to reconcile against. This
 * is that indirection, written last and in one `PutObject` after every window is durable.
 */
export const FDOR_POINTER_KEY = `${RAW_FDOR_PREFIX}current.json`;

/** Where the Glue job writes a run's reconciliation report, beside its manifest. */
export function reconciliationKey(runId: string): string {
  return `${DATA_PREFIXES.manifests}${runId}/reconciliation.json`;
}

/** Mirrored by `raw_archive_key` in `oracle_pipeline/constants.py`, which reads it back. */
export function rawArchiveKey(runId: string): string {
  return `${RAW_ARCHIVE_PREFIX}${runId}/SeminoleCounty.zip`;
}

/** Where the Glue job writes a run's change set. Mirrored by `change_set_key`. */
export function changeSetKey(runId: string): string {
  return `${DATA_PREFIXES.manifests}${runId}/change_set.json`;
}

/** Joined, derived parcel snapshot, partitioned by `geohash5`. */
export const STAGED_PARCELS_PREFIX = `${DATA_PREFIXES.staged}parcels/`;

/**
 * Published snapshots are immutable and run-scoped.
 *
 * `staged/parcels/` is overwritten by every run, so it cannot be what a downstream
 * consumer reads — a reader would see a half-rewritten county. Publication copies the
 * staged snapshot to a key that names its run and is never written again, which is what
 * lets a consumer pin a snapshot and lets two snapshots be compared.
 */
export const PUBLISH_PARCELS_PREFIX = `${DATA_PREFIXES.publish}parcels/`;

export function publishedSnapshotPrefix(runId: string): string {
  return `${PUBLISH_PARCELS_PREFIX}snapshot=${runId}/`;
}

export function publishedChangeSetKey(runId: string): string {
  return `${DATA_PREFIXES.publish}manifests/${runId}/change_set.json`;
}

/**
 * Stable pointer to the snapshot a consumer should read.
 *
 * Written last and in one `PutObject`, after every Parquet object is already durable, so
 * a reader sees either the previous snapshot or the new one and never a partial copy.
 */
export const PUBLISH_POINTER_KEY = `${DATA_PREFIXES.publish}current.json`;
