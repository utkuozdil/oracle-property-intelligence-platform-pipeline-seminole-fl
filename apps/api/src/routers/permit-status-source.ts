export interface PermitStatusSourceState {
  status: 'ingested' | 'in-progress' | 'not-ingested' | 'declined';
  collectedAt: string | null;
  records: number | null;
  cadence: string;
}

export interface PermitStatusCompletion {
  completedAt: string | null;
  records: number | null;
}

const STILL_COLLECTING = 'Still being collected';
const SWEEP_CADENCE = 'Updated when a sweep finishes';

/**
 * Permit-status “Collected” is blank while a sweep is running, then the finish time.
 * An older completed probe must not sit on the row next to today’s in-flight batches.
 */
export function permitStatusSourceState(input: {
  statusBatchCount: number | null;
  latestStatusBatchAt: string | null;
  lastCompletedAt: string | null;
  lastCompletedRecords: number | null;
  /** Permits already written this sweep (or across sweeps) — shown while Collected is still blank. */
  harvestedRecords?: number | null;
}): PermitStatusSourceState {
  const hasBatches = (input.statusBatchCount ?? 0) > 0 || input.latestStatusBatchAt !== null;
  if (!hasBatches && input.lastCompletedAt === null) {
    return {
      status: 'not-ingested',
      collectedAt: null,
      records: null,
      cadence: STILL_COLLECTING,
    };
  }

  const inFlight =
    input.lastCompletedAt === null ||
    (input.latestStatusBatchAt !== null && input.latestStatusBatchAt > input.lastCompletedAt);

  if (inFlight) {
    return {
      status: 'in-progress',
      collectedAt: null,
      records: input.harvestedRecords ?? input.lastCompletedRecords,
      cadence: STILL_COLLECTING,
    };
  }

  return {
    status: 'ingested',
    collectedAt: input.lastCompletedAt,
    records: input.lastCompletedRecords,
    cadence: SWEEP_CADENCE,
  };
}

export function latestTimestamp(values: Array<string | null | undefined>): string | null {
  let latest: string | null = null;
  for (const value of values) {
    if (value === null || value === undefined || value === '') continue;
    if (latest === null || value > latest) latest = value;
  }
  return latest;
}

/** Prefer an explicit finishedAt; fall back to the object’s LastModified. */
export function latestStatusCompletion(
  summaries: Array<{
    lastModified: string | null;
    finishedAt?: string | null;
    permitsLanded?: number | null;
  }>,
): PermitStatusCompletion {
  let completedAt: string | null = null;
  let records: number | null = null;
  for (const summary of summaries) {
    const at = summary.finishedAt ?? summary.lastModified;
    if (at === null || at === '') continue;
    if (completedAt === null || at > completedAt) {
      completedAt = at;
      records = summary.permitsLanded ?? null;
    }
  }
  return { completedAt, records };
}
