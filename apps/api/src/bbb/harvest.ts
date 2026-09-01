/**
 * The BBB harvest: seed the county, look up permit contractors, join, persist.
 *
 * Shape of a run, and why:
 *
 *   city seeds (7 cities x roofing)  ->  contractor name lookups  ->  join  ->  persist
 *
 * The seeds come first so the tier has countywide roofing coverage even if the permit
 * census is still landing, and so the contractor lookups have a candidate pool to match
 * against before they add to it. The lookups then fill in the businesses the seeds missed —
 * necessary because a single search term cannot return more than 225 records no matter how
 * many matches exist (see `MAX_PAGES_PER_SEARCH`).
 *
 * Everything is sequential and paced at ~1 req/s. This tier is small enough that
 * parallelism would buy minutes and risk the only working access path to the source.
 */
import {
  MAX_PAGES_PER_SEARCH,
  RESULTS_PER_PAGE,
  ROOFING_SEED_TERMS,
  SEARCH_DELAY_MS,
  SEMINOLE_CITIES,
} from './config';
import { contractorsFromCensus, dedupeContractors } from './contractors';
import { jitteredDelayMs, sleep, summariseLatency } from './http';
import { matchContractors, matchTierCounts, searchTermFor, type PermitContractor } from './match';
import type { BbbBusinessRecord, BbbHarvestRequest, BbbRunSummary } from './model';
import { normalizeBusinessName } from './normalize';
import { putJson, putNdjson, resolveSink, type ObjectSink } from './objects';
import { anchorLocation, cityLocation, dedupeBusinesses, runSearch } from './search';
import {
  businessesKey,
  contractorRatingsKey,
  currentPointerKey,
  summaryKey,
  unmatchedKey,
} from './storage';

export interface HarvestOptions extends BbbHarvestRequest {
  runId: string;
  sink?: ObjectSink;
  /**
   * Contractors with their permit counts, for callers that have them.
   *
   * `contractorNames` in the request schema is names only, because that is all a Step
   * Functions payload can carry compactly. A caller holding counts passes them here so the
   * output can say how many permits each rating covers, and so the lookup cap spends its
   * budget on the busiest contractors first.
   */
  contractors?: PermitContractor[];
  /** Called with progress lines. The CLI prints them; Lambda logs them. */
  onProgress?: (message: string, detail?: Record<string, unknown>) => void;
}

export interface HarvestResult {
  summary: BbbRunSummary;
  businesses: BbbBusinessRecord[];
  matches: ReturnType<typeof matchContractors>;
}

function ratingDistribution(records: readonly BbbBusinessRecord[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const record of records) {
    const key = record.rating ?? 'unrated';
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

async function resolveContractors(
  sink: ObjectSink,
  request: HarvestOptions,
  warnings: string[],
): Promise<{ contractors: PermitContractor[]; source: string }> {
  const supplied = request.contractors ?? request.contractorNames?.map((name) => ({ name }));
  const mode = request.contractorSource ?? (supplied ? 'request' : 'permits');

  if (mode === 'none') return { contractors: [], source: 'none' };

  if (mode === 'request') {
    const contractors = supplied ?? [];
    return { contractors, source: `caller-supplied (${contractors.length} names)` };
  }

  const { contractors, shardsRead } = await contractorsFromCensus(sink);
  if (contractors.length === 0) {
    /**
     * Not an error. The permit census may simply not have landed yet, and a BBB run that
     * seeded the county is still worth keeping — but the coverage number has to say so
     * rather than read as "no contractors needed rating".
     */
    warnings.push(
      `no contractor names found under staged/permits/census/ (${shardsRead} shards read) — ` +
        'seed coverage only, and the match rate below is measured against an empty list',
    );
  }
  return {
    contractors,
    source: `permit census (${shardsRead} shards, ${contractors.length} distinct names)`,
  };
}

export async function harvest(options: HarvestOptions): Promise<HarvestResult> {
  const sink = options.sink ?? resolveSink();
  const runId = options.runId;
  const startedAt = new Date();
  const report = options.onProgress ?? ((): void => {});
  const warnings: string[] = [];

  const seedCities = options.seedCities ?? true;
  const seedPages = Math.min(options.seedPages ?? MAX_PAGES_PER_SEARCH, MAX_PAGES_PER_SEARCH);

  const collected: BbbBusinessRecord[] = [];
  const latencies: number[] = [];
  let searchesIssued = 0;
  let searchesServedFromLedger = 0;
  let pagesFetched = 0;
  let requestsMade = 0;

  const searchOptions = { sink, runId, freshnessDays: options.freshnessDays };

  if (seedCities) {
    for (const city of SEMINOLE_CITIES) {
      for (const term of ROOFING_SEED_TERMS) {
        const outcome = await runSearch(
          { term, location: cityLocation(city), kind: 'city_seed' },
          { ...searchOptions, maxPages: seedPages },
        );
        searchesIssued += 1;
        if (outcome.fromLedger) searchesServedFromLedger += 1;
        pagesFetched += outcome.pagesFetched;
        requestsMade += outcome.requestsMade;
        latencies.push(...outcome.latencyMs);
        collected.push(...outcome.records);
        if (outcome.truncatedByEndpointCeiling) {
          warnings.push(
            `"${term}" in ${city} reported ${outcome.totalResultsReported} matches but the ` +
              `endpoint caps at ${MAX_PAGES_PER_SEARCH} pages (${outcome.records.length} returned)`,
          );
        }
        report('seed search complete', {
          city,
          term,
          records: outcome.records.length,
          fromLedger: outcome.fromLedger,
        });
        if (!outcome.fromLedger) await sleep(jitteredDelayMs(SEARCH_DELAY_MS));
      }
    }
  }

  const resolved = await resolveContractors(sink, options, warnings);
  const contractors = dedupeContractors(
    resolved.contractors,
    (name) => normalizeBusinessName(name).key,
  ).slice(0, options.contractorLimit ?? 5_000);

  report('contractor list resolved', { source: resolved.source, count: contractors.length });

  for (const contractor of contractors) {
    const term = searchTermFor(contractor.name);
    if (term.length < 3) {
      warnings.push(`skipped "${contractor.name}": no usable search term after normalization`);
      continue;
    }
    /**
     * One page per contractor. A name lookup is narrow by construction — the `JTO Roofing`
     * probe returned 7 results across 1 page — so a second page buys nothing but a request.
     */
    const outcome = await runSearch(
      { term, location: anchorLocation(), kind: 'contractor_name' },
      { ...searchOptions, maxPages: 1 },
    );
    searchesIssued += 1;
    if (outcome.fromLedger) searchesServedFromLedger += 1;
    pagesFetched += outcome.pagesFetched;
    requestsMade += outcome.requestsMade;
    latencies.push(...outcome.latencyMs);
    collected.push(...outcome.records);
    report('contractor lookup complete', {
      contractor: contractor.name,
      term,
      candidates: outcome.records.length,
      fromLedger: outcome.fromLedger,
    });
    if (!outcome.fromLedger) await sleep(jitteredDelayMs(SEARCH_DELAY_MS));
  }

  const businesses = dedupeBusinesses(collected);
  const matches = matchContractors(contractors, businesses);
  const matched = matches.filter((match) => match.matched);
  const finishedAt = new Date();
  const elapsedSeconds = (finishedAt.getTime() - startedAt.getTime()) / 1_000;

  const summary: BbbRunSummary = {
    runId,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    searchesIssued,
    searchesServedFromLedger,
    pagesFetched,
    requestsMade,
    businessesSeen: collected.length,
    businessesDistinct: businesses.length,
    roofingBusinesses: businesses.filter((business) => business.roofing).length,
    ratingDistribution: ratingDistribution(businesses),
    contractorsConsidered: contractors.length,
    contractorsMatched: matched.length,
    matchRate: contractors.length === 0 ? 0 : Number((matched.length / contractors.length).toFixed(4)),
    matchTierCounts: matchTierCounts(matches),
    elapsedSeconds: Number(elapsedSeconds.toFixed(1)),
    requestsPerSecond: elapsedSeconds > 0 ? Number((requestsMade / elapsedSeconds).toFixed(3)) : 0,
    latencyMs: summariseLatency(latencies),
    businessesKey: businessesKey(runId),
    matchesKey: contractorRatingsKey(runId),
    warnings,
    limits: {
      maxPagesPerSearch: MAX_PAGES_PER_SEARCH,
      resultsPerPage: RESULTS_PER_PAGE,
      endpointResultCeilingPerTerm: MAX_PAGES_PER_SEARCH * RESULTS_PER_PAGE,
      contractorNameSource: resolved.source,
    },
  };

  await putNdjson(sink, businessesKey(runId), businesses);
  await putNdjson(sink, contractorRatingsKey(runId), matches);
  await putJson(
    sink,
    unmatchedKey(runId),
    matches.filter((match) => !match.matched),
  );
  await putJson(sink, summaryKey(runId), summary);
  /**
   * The pointer is written last. A reader that follows `current.json` must never be sent to
   * a run whose outputs are still being written.
   */
  await putJson(sink, currentPointerKey(), {
    runId,
    generatedAt: finishedAt.toISOString(),
    businessesKey: summary.businessesKey,
    matchesKey: summary.matchesKey,
    summaryKey: summaryKey(runId),
    businessCount: businesses.length,
    matchedContractorCount: matched.length,
    matchRate: summary.matchRate,
  });

  return { summary, businesses, matches };
}
