export const SKIP_REASON_LABEL: Record<string, string> = {
  'unchanged-etag': 'County file unchanged (same ETag)',
  'concurrent-execution': 'Another refresh was already running',
};

export type SourceStatus = 'ingested' | 'in-progress' | 'not-ingested' | 'declined' | 'skipped';

export interface SourceLike {
  id: string;
  label: string;
  category: string;
  status: Exclude<SourceStatus, 'skipped'>;
  records: number | null;
  recordUnit: string | null;
  collectedAt: string | null;
  cadence: string;
  provenance: string;
}

export interface RunLike {
  runId: string;
  status: 'completed' | 'skipped';
  skipReason: string | null;
  finishedAt: string | null;
  parcelCount: number | null;
}

export interface SourceTableRow {
  key: string;
  sourceId: string;
  category: string;
  label: string;
  status: SourceStatus;
  records: number | null;
  recordUnit: string | null;
  collectedAt: string | null;
  cadence: string;
  provenance: string;
}

export function skipLabel(reason: string | null): string {
  if (reason === null || reason === '') return 'Skipped';
  return SKIP_REASON_LABEL[reason] ?? reason;
}

export function listedSources(sources: readonly SourceLike[]): SourceLike[] {
  return sources.filter(
    (source) => source.status === 'ingested' || source.status === 'in-progress',
  );
}

/**
 * County-file refresh runs share the Property Appraiser row instead of a second table.
 * Other sources stay one row each. Collected on a refresh row is when that check finished.
 */
export function sourceTableRows(
  sources: readonly SourceLike[],
  runs: readonly RunLike[],
  publishedRunId: string | null,
  categoryOrder: readonly string[],
): SourceTableRow[] {
  const ordered = [...listedSources(sources)].sort(
    (a, b) => categoryOrder.indexOf(a.category) - categoryOrder.indexOf(b.category),
  );

  const rows: SourceTableRow[] = [];
  for (const source of ordered) {
    if (source.id === 'scpa-cama' && runs.length > 0) {
      for (const run of runs) {
        rows.push(camaRunRow(source, run, publishedRunId));
      }
      continue;
    }
    rows.push({
      key: source.id,
      sourceId: source.id,
      category: source.category,
      label: source.label,
      status: source.status,
      records: source.records,
      recordUnit: source.recordUnit,
      collectedAt: source.collectedAt,
      cadence: source.cadence,
      provenance: source.provenance,
    });
  }
  return rows;
}

function camaRunRow(
  source: SourceLike,
  run: RunLike,
  publishedRunId: string | null,
): SourceTableRow {
  const skipped = run.status === 'skipped';
  return {
    key: `scpa-cama:${run.runId}`,
    sourceId: source.id,
    category: source.category,
    label: source.label,
    status: skipped ? 'skipped' : 'ingested',
    records: skipped ? null : run.parcelCount,
    recordUnit: skipped ? null : 'parcels',
    collectedAt: run.finishedAt,
    cadence: skipped
      ? skipLabel(run.skipReason)
      : publishedRunId === run.runId
        ? 'Published snapshot'
        : source.cadence,
    provenance: source.provenance,
  };
}
