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
