/**
 * Where the contractor names to look up come from.
 *
 * The harvest is driven by a *list of names*, not by the permit harvest's schedule. That is
 * deliberate: the permit census is landing incrementally, and a name-driven harvest works
 * against whatever exists today and re-runs cheaply as more permits arrive — the ledger
 * means a re-run only pays for names it has not seen before.
 */
import { type ObjectSink, listKeys } from './objects';
import type { PermitContractor } from './match';

/**
 * The permit tier's staged census output.
 *
 * A read-only data-contract dependency on two fields of `staged/permits/census/**` — the
 * permit tier's own `CensusRow` type is not imported, so that tier stays free to change
 * everything this one does not read.
 */
const CENSUS_PREFIX = 'staged/permits/census/';

interface CensusRowSubset {
  contractorName?: unknown;
  roofingRelevant?: unknown;
}

/**
 * Reads distinct contractor names out of the staged permit census, ordered by permit count.
 *
 * Ordering matters because the contractor list is capped: if only part of the list can be
 * looked up in one run, the contractors on the most permits are worth the most.
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
      if (name.length < 3) continue;
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }

  const contractors = [...counts]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([name, permitCount]) => ({ name, permitCount }));

  return { contractors, shardsRead };
}

/**
 * Collapses names that differ only by normalization noise, so one BBB lookup is not spent
 * twice on `ABC ROOFING INC` and `ABC ROOFING, INC.`.
 */
export function dedupeContractors(
  contractors: readonly PermitContractor[],
  keyOf: (name: string) => string,
): PermitContractor[] {
  const byKey = new Map<string, PermitContractor>();
  for (const contractor of contractors) {
    const key = keyOf(contractor.name);
    if (key.length === 0) continue;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...contractor });
      continue;
    }
    existing.permitCount = (existing.permitCount ?? 0) + (contractor.permitCount ?? 0);
    /**
     * Keep the longer spelling. Between a truncated permit rendering and a complete one of
     * the same business, the complete name is the better search term and the better key.
     */
    if (contractor.name.length > existing.name.length) existing.name = contractor.name;
  }
  return [...byKey.values()].sort(
    (left, right) => (right.permitCount ?? 0) - (left.permitCount ?? 0),
  );
}
