/**
 * Accumulating the census as a union rather than a series of overwrites.
 *
 * Source A's pager is stateful and its row order varies between identical queries, so a
 * sweep of one month is a sample of that month, not the whole of it. Two sweeps of the same
 * month agreed on the stated total but differed by ~0.13% in the rows they actually handed
 * over. Keeping only the newest sweep therefore made coverage oscillate: a row present
 * yesterday could be absent today through nothing but pager luck.
 *
 * Merging every sweep into one key per month makes a re-harvest additive, so coverage only
 * ever climbs and drift converges instead of oscillating. It also answers a question the
 * feasibility work left open — whether an already-harvested row can change after issuance —
 * because a merge can see the before and after and counts the difference.
 */
import { logger } from '../observability';
import type { CensusRow } from './model';
import { PreconditionFailedError, getTextIfPresent, putTextConditional } from './objects';

/** Enough attempts to outlast a concurrent writer, few enough to fail loudly if wedged. */
const MAX_MERGE_ATTEMPTS = 5;

export interface MergeOutcome {
  rows: CensusRow[];
  /** Rows this sweep saw for the first time ever. */
  added: number;
  /** Rows already held whose source-derived content this sweep found changed. */
  updated: number;
  /** Rows already held that this sweep did not return — kept, and the reason for the union. */
  carriedOver: number;
  /** Rows already held that this sweep returned unchanged. */
  confirmed: number;
}

/** The source-derived fields. Excludes provenance, which changes on every sweep by design. */
function contentOf(row: CensusRow): string {
  return JSON.stringify([
    row.appNo,
    row.description,
    row.parcelId,
    row.propertyAddress,
    row.cityCode,
    row.stateCode,
    row.zipCode,
    row.propertySubdivision,
    row.structureSequence,
    row.permitTypeSequence,
    row.issueDate,
    row.permitType,
    row.ownerName,
    row.contractorName,
    row.valuationAmount,
  ]);
}

/**
 * Union of what is already held with what this sweep saw, keyed on `rowKey`.
 *
 * Where both sides hold a row the fresh one wins, because a revision after issuance is the
 * one case where the older copy is the wrong answer. `firstSeenRunId` survives from the
 * older copy so the union keeps a record of when coverage was actually reached.
 */
export function mergeCensusRows(
  existing: readonly CensusRow[],
  fresh: readonly CensusRow[],
  runId: string,
): MergeOutcome {
  const merged = new Map<string, CensusRow>();
  for (const row of existing) merged.set(row.rowKey, row);

  let added = 0;
  let updated = 0;
  let confirmed = 0;

  for (const row of fresh) {
    const held = merged.get(row.rowKey);
    if (!held) {
      added += 1;
      merged.set(row.rowKey, { ...row, firstSeenRunId: runId, lastSeenRunId: runId });
      continue;
    }
    const changed = contentOf(held) !== contentOf(row);
    if (changed) updated += 1;
    else confirmed += 1;
    merged.set(row.rowKey, {
      ...row,
      firstSeenRunId: held.firstSeenRunId ?? runId,
      lastSeenRunId: runId,
    });
  }

  return {
    // Sorted so the object is byte-stable for a given set of rows, which makes an unchanged
    // month's ETag meaningful rather than churning on map iteration order.
    rows: [...merged.values()].sort((left, right) => left.rowKey.localeCompare(right.rowKey)),
    added,
    updated,
    carriedOver: existing.length - (updated + confirmed),
    confirmed,
  };
}

function parseNdjson(body: string): CensusRow[] {
  const rows: CensusRow[] = [];
  for (const line of body.split('\n')) {
    if (line.trim()) rows.push(JSON.parse(line) as CensusRow);
  }
  return rows;
}

function serialiseNdjson(rows: readonly CensusRow[]): string {
  return rows.map((row) => JSON.stringify(row)).join('\n');
}

/**
 * Read-merge-write one month's accumulated rows under an ETag precondition.
 *
 * One shard per `(type, month)` per run makes this a single writer within a run, but two
 * overlapping runs — a schedule firing while an operator backfill is mid-flight — would
 * otherwise each read, merge, and write, and the later write would drop the earlier one's
 * additions. The precondition turns that into a retry rather than silent data loss.
 */
export async function accumulateMonth(
  key: string,
  fresh: readonly CensusRow[],
  runId: string,
): Promise<MergeOutcome> {
  let lastConflict: unknown;
  for (let attempt = 1; attempt <= MAX_MERGE_ATTEMPTS; attempt += 1) {
    const current = await getTextIfPresent(key);
    const existing = current.body === null ? [] : parseNdjson(current.body);
    const outcome = mergeCensusRows(existing, fresh, runId);
    try {
      await putTextConditional(
        key,
        serialiseNdjson(outcome.rows),
        'application/x-ndjson',
        current.etag,
      );
      return outcome;
    } catch (error) {
      if (!(error instanceof PreconditionFailedError)) throw error;
      lastConflict = error;
      logger.warn('Census union write lost its race, re-merging', { key, attempt });
      await new Promise((resolve) => setTimeout(resolve, 200 * attempt + Math.random() * 200));
    }
  }
  throw new Error(
    `could not accumulate ${key} after ${MAX_MERGE_ATTEMPTS} attempts: ${String(lastConflict)}`,
  );
}
