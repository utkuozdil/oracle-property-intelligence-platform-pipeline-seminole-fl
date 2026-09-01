/**
 * Durable roofing worklist so status planning does not re-read every census month.
 *
 * Status itself is already a Dynamo row per application (`PERMITSTATUS#<appNo>`). What was
 * missing is the *candidate* list — which applications are roofing and how old they are —
 * which the planner was rebuilding from ~368 S3 shards on every local sweep. This index is
 * that list: one NDJSON object plus a Dynamo pointer keyed by a fingerprint of the month
 * shards. A later plan that sees the same fingerprint loads one file and asks the ledger
 * which of those it already harvested.
 */
import { createHash } from 'node:crypto';
import { logger } from '../observability';
import {
  readCandidateIndexPointer,
  recordCandidateIndexPointer,
} from './ledger';
import type { RoofingMatchRule } from './model';
import { getJson, getText, putNdjson, putJson, type ListedObject } from './objects';
import {
  isCensusMonthRowsKey,
  roofingCandidateIndexKey,
  roofingCandidateIndexMetaKey,
} from './storage';

export interface RoofingCandidateRecord {
  appNo: string;
  earliestAge: string;
  latestAge: string;
  roofingMatchedBy: RoofingMatchRule[];
  earliestTrustedIssue: string | null;
  earliestMonth: string;
}

export interface CandidateIndexMeta {
  fingerprint: string;
  count: number;
  allApplications: number;
  builtAt: string;
}

export interface LoadedCandidateIndex {
  records: RoofingCandidateRecord[];
  allApplications: number;
  fingerprint: string;
  source: 'index' | 'missing';
}

export function fingerprintMonthShards(objects: readonly ListedObject[]): string {
  const lines = objects
    .filter((object) => isCensusMonthRowsKey(object.key))
    .map((object) => `${object.key}\t${object.lastModified ?? ''}`)
    .sort();
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

export function serializeCandidates(records: readonly RoofingCandidateRecord[]): RoofingCandidateRecord[] {
  return [...records].sort((left, right) => left.appNo.localeCompare(right.appNo));
}

export function parseCandidateNdjson(body: string): RoofingCandidateRecord[] {
  const records: RoofingCandidateRecord[] = [];
  for (const line of body.split('\n')) {
    if (!line) continue;
    records.push(JSON.parse(line) as RoofingCandidateRecord);
  }
  return records;
}

export async function loadRoofingCandidateIndex(
  fingerprint: string,
): Promise<LoadedCandidateIndex> {
  const pointer = await readCandidateIndexPointer();
  const meta = await getJson<CandidateIndexMeta>(roofingCandidateIndexMetaKey()).catch(() => null);

  const fresh =
    (pointer?.fingerprint === fingerprint && pointer.count > 0) ||
    (meta?.fingerprint === fingerprint && (meta.count ?? 0) > 0);

  if (!fresh) {
    return { records: [], allApplications: 0, fingerprint, source: 'missing' };
  }

  const body = await getText(roofingCandidateIndexKey());
  const records = parseCandidateNdjson(body);
  return {
    records,
    allApplications: pointer?.allApplications ?? meta?.allApplications ?? records.length,
    fingerprint,
    source: 'index',
  };
}

export async function saveRoofingCandidateIndex(options: {
  records: readonly RoofingCandidateRecord[];
  allApplications: number;
  fingerprint: string;
}): Promise<void> {
  const builtAt = new Date().toISOString();
  const rowsKey = roofingCandidateIndexKey();
  const ordered = serializeCandidates(options.records);
  const meta: CandidateIndexMeta = {
    fingerprint: options.fingerprint,
    count: ordered.length,
    allApplications: options.allApplications,
    builtAt,
  };
  await putNdjson(rowsKey, ordered);
  await putJson(roofingCandidateIndexMetaKey(), meta);
  try {
    await recordCandidateIndexPointer({
      fingerprint: options.fingerprint,
      count: ordered.length,
      allApplications: options.allApplications,
      builtAt,
      rowsKey,
    });
  } catch (error) {
    logger.warn('Candidate-index pointer write failed; S3 index is still usable', { error });
  }
  logger.info('Wrote roofing candidate index', {
    count: ordered.length,
    allApplications: options.allApplications,
  });
}
