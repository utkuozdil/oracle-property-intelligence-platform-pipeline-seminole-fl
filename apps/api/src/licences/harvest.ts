/**
 * The licence harvest: download, parse, filter to the county, join to permit contractors,
 * persist.
 *
 * Shape of a run, and why:
 *
 *   ledger check -> download (2 requests) -> single parse pass -> join -> persist -> pointer
 *
 * There is no Distributed Map, no sharding and no cost gate, and that is a consequence of the
 * source rather than an omission. A run is **two HTTP requests**: one 48.8 MB file that the
 * host serves at about 188 KB/s. Nothing about that is parallelisable — the file is a single
 * object with no server-side filter — and sharding would only multiply the request count at a
 * host that escalates after roughly twenty requests in a few minutes. A cost gate would guard
 * a sub-cent invocation.
 *
 * The one non-obvious ordering: contractor names are resolved *before* the download, because
 * the parse pass needs to know which out-of-county licence serials to retain (see
 * `referencedSerials`).
 */
import {
  DBPR_LICENCE_CSV_URL,
  DEFAULT_FRESHNESS_DAYS,
  LEDGER_SCHEMA_VERSION,
  MATCH_CONFIDENCE_FLOOR,
  JOIN_COUNTY_CODES,
  ROOFING_CAPABLE_CLASSES,
} from './config';
import { contractorsFromCensus, dedupeContractors } from './contractors';
import { decodeLatin1 } from './csv';
import { parseExtract } from './extract';
import { downloadExtract, type ExtractDownload } from './http';
import {
  buildLicenceIndex,
  matchContractors,
  matchTierCounts,
  QUALIFIER_SEED_PREFIXES,
  referencedSerials,
  type PermitContractor,
} from './match';
import type {
  ContractorLicenceMatch,
  LicenceHarvestRequest,
  LicenceRecord,
  LicenceRunSummary,
} from './model';
import { getJson, putJson, putNdjson, resolveSink, type ObjectSink } from './objects';
import { mostRecentRenewalDeadline } from './parse';
import {
  adverseLicencesKey,
  contractorLicencesKey,
  currentPointerKey,
  ledgerKey,
  licencesKey,
  rawExtractKey,
  summaryKey,
  unmatchedKey,
} from './storage';

export interface HarvestOptions extends LicenceHarvestRequest {
  runId: string;
  sink?: ObjectSink;
  contractors?: PermitContractor[];
  /** Called with progress lines. The CLI prints them; Lambda logs them. */
  onProgress?: (message: string, detail?: Record<string, unknown>) => void;
  /**
   * Supplies the extract instead of downloading it. Used by the local runner against an
   * already-downloaded file, so the matcher can be iterated without paying 260 seconds and a
   * request to DBPR for every pass.
   */
  extractOverride?: ExtractDownload;
}

export interface HarvestResult {
  summary: LicenceRunSummary;
  licences: LicenceRecord[];
  matches: ContractorLicenceMatch[];
}

/**
 * The ledger entry. Holds the derived county records, not the 48.8 MB body.
 *
 * Storing records rather than bytes is why `LEDGER_SCHEMA_VERSION` exists: a change to
 * `LicenceRecord` makes every entry unusable, and bumping the version invalidates them all
 * rather than deserializing an old shape into a new type.
 */
interface LedgerEntry {
  schemaVersion: number;
  sourceUrl: string;
  fetchedAt: string;
  sourceLastModified: string | null;
  downloadBytes: number;
  rowsParsed: number;
  countyRecords: LicenceRecord[];
  outOfCountyRecords: LicenceRecord[];
  licencePrefixes: string[];
}

function counter(values: Iterable<string>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

/** Splits the expired population at the biennial deadline; see `LicenceRunSummary`. */
function expiredBreakdown(
  records: readonly LicenceRecord[],
  asOf: Date,
): LicenceRunSummary['expiredBreakdown'] {
  const renewalDeadline = mostRecentRenewalDeadline(asOf);
  let atRenewalDeadline = 0;
  let longLapsed = 0;
  for (const record of records) {
    if (record.standing !== 'expired') continue;
    if (record.expirationDate === renewalDeadline) atRenewalDeadline += 1;
    else longLapsed += 1;
  }

  const total = atRenewalDeadline + longLapsed;
  const share = total === 0 ? 0 : Math.round((atRenewalDeadline / total) * 100);
  const note =
    total === 0
      ? 'No expired licences in this run.'
      : `${atRenewalDeadline} of ${total} expired licences (${share}%) expired on ` +
        `${renewalDeadline}, Florida's biennial renewal deadline — construction licences all ` +
        'expire on 31 August of even years and DBPR takes weeks to process the renewals. That ' +
        'is a calendar artefact, not a collapse in contractor standing, and most of those ' +
        `licences will simply renew. The ${longLapsed} that lapsed before the deadline are ` +
        'the genuine signal. Do not read the expired total without this split.';

  return { renewalDeadline, atRenewalDeadline, longLapsed, note };
}

/**
 * Why the adverse-contractor count is scoped the way it is.
 *
 * Emitted alongside the number because the number is smaller than a reader would expect and
 * the reason is not guessable. Stated with the case that forced it: rolling up every trade a
 * business is qualified in flagged the largest roofer in the census over a lapsed licence in a
 * trade that has nothing to do with roofing.
 */
const ADVERSE_SIGNAL_BASIS =
  'Counted on each matched contractor\'s own best roofing-capable licence ' +
  `(${[...ROOFING_CAPABLE_CLASSES].join(', ')}), not on the worst licence anywhere in the ` +
  'business. Two exclusions are deliberate. Licences in unrelated trades are excluded: rolling ' +
  'up every trade made COLLIS ROOFING, INC. — 760 Seminole permits, the largest roofer in the ' +
  'census — read "expired" on the strength of a third qualifier\'s lapsed CFC plumbing licence, ' +
  'while its own roofing CCC and general CGC both run to 2028. QB registration rows are ' +
  'excluded because they carry no expiry or secondary status, so their "current_unspecified" is ' +
  'an absence of information that would otherwise outrank a real expiry. The broader signal is ' +
  'still on every match row as worstStanding.';

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

  const { contractors, shardsRead } = await contractorsFromCensus(sink, {
    roofingOnly: request.roofingOnly ?? true,
  });
  if (contractors.length === 0) {
    /**
     * Not an error. The licence dataset is worth publishing on its own — it is the county's
     * contractor-licence population — but the match rate has to say it was measured against
     * an empty list rather than read as "no contractors needed a licence check".
     */
    warnings.push(
      `no contractor names found under staged/permits/census/ (${shardsRead} shards read) — ` +
        'licences were still published, and the match rate below is measured against an empty list',
    );
  }
  return {
    contractors,
    source: `permit census (${shardsRead} shards, ${contractors.length} distinct names)`,
  };
}

/**
 * Returns a usable ledger entry, or null.
 *
 * The freshness window is short (3 days) because DBPR republishes at least daily, so this is
 * not a cache in the "avoid ever refetching" sense — it exists so a retry, a manual re-run, or
 * a second execution on the same day does not pay 260 seconds of download and another two
 * requests at a host that throttles.
 */
async function readLedger(
  sink: ObjectSink,
  sourceUrl: string,
  freshnessDays: number,
): Promise<LedgerEntry | null> {
  if (freshnessDays <= 0) return null;
  const entry = await getJson<LedgerEntry>(sink, ledgerKey(sourceUrl));
  if (!entry || entry.schemaVersion !== LEDGER_SCHEMA_VERSION) return null;
  const age = Date.now() - Date.parse(entry.fetchedAt);
  if (!Number.isFinite(age) || age > freshnessDays * 86_400_000) return null;
  return entry;
}

export async function harvest(options: HarvestOptions): Promise<HarvestResult> {
  const sink = options.sink ?? resolveSink();
  const runId = options.runId;
  const startedAt = new Date();
  const report = options.onProgress ?? ((): void => {});
  const warnings: string[] = [];
  const freshnessDays = options.freshnessDays ?? DEFAULT_FRESHNESS_DAYS;

  const resolved = await resolveContractors(sink, options, warnings);
  const contractors = dedupeContractors(resolved.contractors);
  report('contractor list resolved', { source: resolved.source, count: contractors.length });

  /**
   * Serials are collected with a seed prefix set rather than the real one, because the real
   * set only exists after the file is parsed. The seed covers every prefix that appears in a
   * qualifier parenthetical in the census; a prefix missing from it costs one licence-serial
   * match, not a wrong one.
   */
  const wantedSerials = referencedSerials(contractors, QUALIFIER_SEED_PREFIXES);

  const ledgerEntry = await readLedger(sink, DBPR_LICENCE_CSV_URL, freshnessDays);

  let countyRecords: LicenceRecord[];
  let outOfCountyRecords: LicenceRecord[];
  let rowsParsed: number;
  let raggedCount: number;
  let sourceUrl: string;
  let fetchedAt: string;
  let sourceLastModified: string | null;
  let downloadBytes: number;
  let downloadSeconds: number;
  const servedFromLedger = ledgerEntry !== null && options.extractOverride === undefined;

  if (ledgerEntry !== null && options.extractOverride === undefined) {
    report('served from ledger', { fetchedAt: ledgerEntry.fetchedAt });
    countyRecords = ledgerEntry.countyRecords;
    outOfCountyRecords = ledgerEntry.outOfCountyRecords;
    rowsParsed = ledgerEntry.rowsParsed;
    raggedCount = 0;
    sourceUrl = ledgerEntry.sourceUrl;
    fetchedAt = ledgerEntry.fetchedAt;
    sourceLastModified = ledgerEntry.sourceLastModified;
    downloadBytes = ledgerEntry.downloadBytes;
    downloadSeconds = 0;
  } else {
    const download = options.extractOverride ?? (await downloadExtract());
    report('extract downloaded', {
      bytes: download.bytes.byteLength,
      seconds: Number((download.durationMs / 1_000).toFixed(1)),
      lastModified: download.lastModified,
    });

    if (options.keepRawCopy === true) {
      await sink.putBytes(rawExtractKey(runId), download.bytes, 'text/csv');
    }

    const parsed = parseExtract({
      text: decodeLatin1(download.bytes),
      sourceUrl: download.sourceUrl,
      fetchedAt: download.fetchedAt,
      // One instant for the whole run, so an expiry boundary cannot fall differently for two
      // records in the same file.
      asOf: startedAt,
      countyCodes: JOIN_COUNTY_CODES,
      wantedSerials,
    });

    countyRecords = parsed.countyRecords;
    outOfCountyRecords = parsed.outOfCountyRecords;
    rowsParsed = parsed.rowsParsed;
    raggedCount = parsed.raggedRows.length;
    sourceUrl = download.sourceUrl;
    fetchedAt = download.fetchedAt;
    sourceLastModified = download.lastModified;
    downloadBytes = download.bytes.byteLength;
    downloadSeconds = Number((download.durationMs / 1_000).toFixed(1));

    if (raggedCount > 0) {
      warnings.push(
        `${raggedCount} rows did not have the expected 22 fields and were skipped ` +
          `(first at line ${parsed.raggedRows[0]?.line}) — 0 were observed on 2026-09-01`,
      );
    }

    report('extract parsed', {
      rowsParsed,
      countyRecords: countyRecords.length,
      outOfCountyRecords: outOfCountyRecords.length,
    });

    const entry: LedgerEntry = {
      schemaVersion: LEDGER_SCHEMA_VERSION,
      sourceUrl,
      fetchedAt,
      sourceLastModified,
      downloadBytes,
      rowsParsed,
      countyRecords,
      outOfCountyRecords,
      licencePrefixes: [...parsed.licencePrefixes],
    };
    await putJson(sink, ledgerKey(sourceUrl), entry);
  }

  if (countyRecords.length === 0) {
    warnings.push(
      `no licences found for county codes ${[...JOIN_COUNTY_CODES].join(', ')} — ` +
        'the county-code column may have changed meaning',
    );
  }

  const index = buildLicenceIndex(countyRecords, outOfCountyRecords);
  const matches = matchContractors(contractors, index);
  const matched = matches.filter((match) => match.matched);
  const keyed = matched.filter((match) => match.keyedMatch);

  const finishedAt = new Date();
  const adverse = countyRecords.filter((record) => record.adverse);

  const summary: LicenceRunSummary = {
    runId,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    sourceUrl,
    fetchedAt,
    sourceLastModified,
    servedFromLedger,
    downloadBytes,
    downloadSeconds,
    rowsParsed,
    raggedRows: raggedCount,
    seminoleLicences: countyRecords.length,
    qualifiedBusinessRows: countyRecords.filter((record) => record.qualifiedBusiness).length,
    licencedRows: countyRecords.filter((record) => record.licenceNumber !== null).length,
    standingDistribution: counter(countyRecords.map((record) => record.standing)),
    expiredBreakdown: expiredBreakdown(countyRecords, startedAt),
    primaryStatusDistribution: counter(countyRecords.map((record) => record.primaryStatus)),
    secondaryStatusDistribution: counter(
      countyRecords.map((record) => record.secondaryStatus ?? 'unspecified'),
    ),
    licenceTypeDistribution: counter(countyRecords.map((record) => record.licenceType)),
    adverseLicences: adverse.length,
    contractorsConsidered: contractors.length,
    contractorsMatched: matched.length,
    contractorsMatchedByKey: keyed.length,
    matchRate:
      contractors.length === 0 ? 0 : Number((matched.length / contractors.length).toFixed(4)),
    keyedMatchRate:
      contractors.length === 0 ? 0 : Number((keyed.length / contractors.length).toFixed(4)),
    matchTierCounts: matchTierCounts(matches),
    /**
     * Counted on the *headline* licence, not the worst one the business holds.
     *
     * The lead this product sells is "this contractor cannot currently roof lawfully", and
     * that is a statement about their best credential. Counting the worst instead conflates it
     * with "some credential attached to this business has lapsed", which is a far weaker claim
     * and was wrong in practice: `SKY LIGHT ROOFING INC` holds a roofing `CCC` current to 2028
     * and a general `CGC` that lapsed, and appeared as an expired-licence lead on the strength
     * of the latter. `worstStanding` is still on every row for anyone who wants it.
     */
    contractorsWithAdverseLicence: matched.filter((match) => match.adverse === true).length,
    adverseSignalBasis: ADVERSE_SIGNAL_BASIS,
    elapsedSeconds: Number(((finishedAt.getTime() - startedAt.getTime()) / 1_000).toFixed(1)),
    licencesKey: licencesKey(runId),
    matchesKey: contractorLicencesKey(runId),
    warnings,
    limits: {
      countyCodes: [...JOIN_COUNTY_CODES],
      statewideExactKeyFallback: true,
      contractorNameSource: resolved.source,
      confidenceFloor: MATCH_CONFIDENCE_FLOOR,
    },
  };

  await putNdjson(sink, licencesKey(runId), countyRecords);
  await putNdjson(sink, contractorLicencesKey(runId), matches);
  await putNdjson(sink, adverseLicencesKey(runId), adverse);
  await putJson(
    sink,
    unmatchedKey(runId),
    matches.filter((match) => !match.matched),
  );
  await putJson(sink, summaryKey(runId), summary);
  /**
   * The pointer is written last. A reader following `current.json` must never be sent to a run
   * whose outputs are still being written.
   */
  await putJson(sink, currentPointerKey(), {
    runId,
    generatedAt: finishedAt.toISOString(),
    licencesKey: summary.licencesKey,
    matchesKey: summary.matchesKey,
    adverseKey: adverseLicencesKey(runId),
    summaryKey: summaryKey(runId),
    sourceLastModified,
    licenceCount: countyRecords.length,
    matchedContractorCount: matched.length,
    matchRate: summary.matchRate,
    keyedMatchRate: summary.keyedMatchRate,
    contractorsWithAdverseLicence: summary.contractorsWithAdverseLicence,
  });

  report('run complete', {
    licences: countyRecords.length,
    matched: matched.length,
    keyedMatches: keyed.length,
    adverseLicences: adverse.length,
  });

  return { summary, licences: countyRecords, matches };
}
