/**
 * Where the contractor names to join come from.
 *
 * A read-only data-contract dependency on two fields of the permit tier's staged census. That
 * tier's own row type is deliberately not imported, so it stays free to change everything
 * this one does not read.
 */
import type { PermitContractor } from './match';
import { listKeys, type ObjectSink } from './objects';
import { normalizeBusinessName } from './normalize';

const CENSUS_PREFIX = 'staged/permits/census/';

interface CensusRowSubset {
  contractorName?: unknown;
  roofingRelevant?: unknown;
}

/**
 * Names that are not contractors.
 *
 * `OWNER BUILDER` is the highest-count "contractor" in the census at 1,317 permits and is a
 * homeowner pulling their own permit. It has no licence by definition, so counting it as an
 * unmatched contractor would understate the match rate against a name that can never match.
 */
const NON_CONTRACTOR_NAMES = new Set(['OWNER BUILDER', 'OWNER', 'HOMEOWNER', 'OWNER/BUILDER']);

export function isRealContractorName(name: string): boolean {
  const normalized = name.toUpperCase().replace(/[^A-Z ]+/g, ' ').replace(/\s+/g, ' ').trim();
  return !NON_CONTRACTOR_NAMES.has(normalized);
}

/**
 * Reads distinct contractor names out of the staged permit census, ordered by permit count.
 *
 * The census is written both as month/type-partitioned shards and as `run=`-partitioned
 * shards of the same rows, so the same permit is read more than once. That inflates permit
 * counts but not the *set* of names, and the counts are only used for ordering and for
 * reporting how many permits a match covers — so the duplication is tolerated rather than
 * guessed at from the permit tier's key layout, which this tier does not own.
 */
export async function contractorsFromCensus(
  sink: ObjectSink,
  options: { roofingOnly?: boolean } = {},
): Promise<{ contractors: PermitContractor[]; shardsRead: number }> {
  const roofingOnly = options.roofingOnly ?? true;
  const keys = (await listKeys(sink, CENSUS_PREFIX)).filter((key) => key.endsWith('.ndjson'));

  const counts = new Map<string, number>();
  let shardsRead = 0;

  for (const key of keys) {
    const text = await sink.getText(key);
    if (text === null) continue;
    shardsRead += 1;
    for (const line of text.split('\n')) {
      if (line.trim().length === 0) continue;
      let row: CensusRowSubset;
      try {
        row = JSON.parse(line) as CensusRowSubset;
      } catch {
        // A malformed line is the permit tier's problem to report, not this tier's to guess at.
        continue;
      }
      if (roofingOnly && row.roofingRelevant !== true) continue;
      const name = typeof row.contractorName === 'string' ? row.contractorName.trim() : '';
      if (name.length < 3 || !isRealContractorName(name)) continue;
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }

  const contractors = [...counts]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([name, permitCount]) => ({ name, permitCount }));

  return { contractors, shardsRead };
}

/**
 * Collapses names that differ only by normalization noise.
 *
 * Note this is *not* the same as collapsing names that refer to the same business: the census
 * carries `FLEMING BROTHERS ROOFING CO` and `FLEMING BROS ROOFING CO INC` as separate names,
 * and both survive here because both are strings a permit was actually pulled under and both
 * have to be joinable. Only exact normalization collisions are merged.
 */
export function dedupeContractors(
  contractors: readonly PermitContractor[],
): PermitContractor[] {
  const byKey = new Map<string, PermitContractor>();
  for (const contractor of contractors) {
    const key = normalizeBusinessName(contractor.name).key;
    if (key.length === 0) continue;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...contractor });
      continue;
    }
    existing.permitCount = (existing.permitCount ?? 0) + (contractor.permitCount ?? 0);
    // Between a truncated rendering and a complete one, the complete name is the better key.
    if (contractor.name.length > existing.name.length) existing.name = contractor.name;
  }
  return [...byKey.values()].sort(
    (left, right) => (right.permitCount ?? 0) - (left.permitCount ?? 0),
  );
}
