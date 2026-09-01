/**
 * Issuing a BBB search and turning the response into records.
 *
 * Raw-first: the response HTML is written before it is parsed, so a parser change can be
 * replayed against exactly what BBB served rather than requiring another crawl.
 */
import {
  ANCHOR_CITY,
  BBB_ORIGIN,
  BBB_SEARCH_URL,
  DEFAULT_FRESHNESS_DAYS,
  isRatingGrade,
  LEDGER_SCHEMA_VERSION,
  MAX_PAGES_PER_SEARCH,
  ROOFING_CATEGORY_PREFIX,
  SEARCH_DELAY_MS,
  STATE,
} from './config';
import type { BbbBusinessRecord, SearchKind } from './model';
import { type ObjectSink, getJson, putJson } from './objects';
import {
  cityFromReportUrl,
  parseSearchPayload,
  stripHighlightTags,
  type RawBbbResult,
} from './preloaded-state';
import { jitteredDelayMs, requestWithRetry, sleep } from './http';
import { ledgerKey, searchPageRawKey } from './storage';

export interface SearchQuery {
  term: string;
  /** `City, ST`. Name lookups are not location-bound; the anchor city is used for them. */
  location: string;
  kind: SearchKind;
  page: number;
}

export function searchUrl(query: { term: string; location: string; page: number }): string {
  const params = new URLSearchParams({
    find_country: 'USA',
    find_loc: query.location,
    find_text: query.term,
    page: String(query.page),
  });
  return `${BBB_SEARCH_URL}?${params.toString()}`;
}

export function anchorLocation(): string {
  return `${ANCHOR_CITY}, ${STATE}`;
}

export function cityLocation(city: string): string {
  return `${city}, ${STATE}`;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const text = asString(entry);
    return text ? [text] : [];
  });
}

function categoryIdsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const id = asString((entry as { id?: unknown } | null)?.id);
    return id ? [id] : [];
  });
}

/** Maps one raw result to a stored record, attaching provenance. */
export function toBusinessRecord(
  raw: RawBbbResult,
  context: { sourceUrl: string; fetchedAt: string; rawKey: string | null; query: SearchQuery },
): BbbBusinessRecord | null {
  const businessName = asString(raw.businessName);
  if (!businessName) return null;

  const reportUrl = asString(raw.reportUrl);
  const derived = reportUrl ? cityFromReportUrl(reportUrl) : { city: null, state: null };
  const categoryIds = categoryIdsOf(raw.categories);
  const primaryCategory = asString(raw.tobText);
  const rating = asString(raw.rating);
  const businessId = asString(raw.businessId) ?? asString(raw.id);
  if (!businessId) return null;

  return {
    bbbRecordId: asString(raw.id) ?? businessId,
    businessId,
    businessName: stripHighlightTags(businessName),
    alsoKnownAs: [],
    rating: rating && isRatingGrade(rating) ? rating : null,
    ratingScore: typeof raw.ratingScore === 'number' ? raw.ratingScore : null,
    accredited: raw.bbbMember === true,
    streetAddress: asString(raw.address),
    city: derived.city,
    state: derived.state,
    postalCode: asString(raw.postalcode),
    payloadCity: asString(raw.city),
    phones: asStringArray(raw.phone),
    primaryCategory,
    categoryIds,
    roofing:
      categoryIds.some((id) => id.startsWith(ROOFING_CATEGORY_PREFIX)) ||
      /roof/i.test(primaryCategory ?? ''),
    serviceAreas: asStringArray(raw.serviceAreasSummary).map((area) =>
      area.replace(/\s+/g, ' ').trim(),
    ),
    outOfBusiness: asString(raw.outOfBusinessStatus) !== null,
    profileUrl: reportUrl ? new URL(reportUrl, BBB_ORIGIN).toString() : null,
    sourceUrl: context.sourceUrl,
    fetchedAt: context.fetchedAt,
    rawKey: context.rawKey,
    searchKind: context.query.kind,
    searchTerm: context.query.term,
    searchLocation: context.query.location,
  };
}

/** What one search (all its pages) produced. */
export interface SearchOutcome {
  term: string;
  location: string;
  kind: SearchKind;
  records: BbbBusinessRecord[];
  pagesFetched: number;
  requestsMade: number;
  totalResultsReported: number | null;
  totalPagesReported: number | null;
  /** True when the whole search was answered from the ledger without a request. */
  fromLedger: boolean;
  latencyMs: number[];
  /** Set when the endpoint reported more matches than its 15-page ceiling can return. */
  truncatedByEndpointCeiling: boolean;
}

interface LedgerEntry {
  schemaVersion: number;
  searchUrl: string;
  term: string;
  location: string;
  kind: SearchKind;
  fetchedAt: string;
  pagesFetched: number;
  totalResultsReported: number | null;
  totalPagesReported: number | null;
  records: BbbBusinessRecord[];
}

function isFresh(entry: LedgerEntry, freshnessDays: number): boolean {
  if (freshnessDays <= 0) return false;
  if (entry.schemaVersion !== LEDGER_SCHEMA_VERSION) return false;
  const age = Date.now() - Date.parse(entry.fetchedAt);
  return Number.isFinite(age) && age >= 0 && age < freshnessDays * 86_400_000;
}

export interface RunSearchOptions {
  sink: ObjectSink;
  runId: string;
  maxPages?: number;
  freshnessDays?: number;
  /** Written for provenance. Disabled only by tests. */
  writeRaw?: boolean;
}

/**
 * Runs one search to a page bound, sequentially and paced.
 *
 * Pagination stops on the first of: the reported page count, the requested bound, the
 * endpoint's 15-page ceiling, or an empty page. A search whose reported total exceeds what
 * 15 pages can return is flagged rather than silently accepted as complete.
 */
export async function runSearch(
  query: { term: string; location: string; kind: SearchKind },
  options: RunSearchOptions,
): Promise<SearchOutcome> {
  const { sink, runId } = options;
  const maxPages = Math.min(options.maxPages ?? 1, MAX_PAGES_PER_SEARCH);
  const freshnessDays = options.freshnessDays ?? DEFAULT_FRESHNESS_DAYS;

  /**
   * Idempotency is keyed on page 1's URL, which identifies the search as a whole. A search
   * is re-fetched only when it has never been run or has gone stale.
   */
  const identityUrl = searchUrl({ ...query, page: 1 });
  const cached = await getJson<LedgerEntry>(sink, ledgerKey(identityUrl));
  if (cached && isFresh(cached, freshnessDays) && cached.pagesFetched >= maxPages) {
    return {
      ...query,
      records: cached.records,
      pagesFetched: cached.pagesFetched,
      requestsMade: 0,
      totalResultsReported: cached.totalResultsReported,
      totalPagesReported: cached.totalPagesReported,
      fromLedger: true,
      latencyMs: [],
      truncatedByEndpointCeiling:
        (cached.totalResultsReported ?? 0) > cached.records.length &&
        cached.pagesFetched >= MAX_PAGES_PER_SEARCH,
    };
  }

  const records: BbbBusinessRecord[] = [];
  const latencyMs: number[] = [];
  let pagesFetched = 0;
  let requestsMade = 0;
  let totalResultsReported: number | null = null;
  let totalPagesReported: number | null = null;

  for (let page = 1; page <= maxPages; page += 1) {
    if (page > 1) await sleep(jitteredDelayMs(SEARCH_DELAY_MS));

    const url = searchUrl({ ...query, page });
    const outcome = await requestWithRetry(url);
    requestsMade += 1;
    latencyMs.push(outcome.durationMs);
    const fetchedAt = new Date().toISOString();

    const rawKey = searchPageRawKey({ runId, location: query.location, term: query.term, page });
    if (options.writeRaw !== false) {
      await sink.putText(rawKey, outcome.body, 'text/html; charset=utf-8');
    }

    const payload = parseSearchPayload(outcome.body);
    pagesFetched += 1;
    totalResultsReported ??= payload.totalResults;
    totalPagesReported ??= payload.totalPages;

    for (const raw of payload.results) {
      const record = toBusinessRecord(raw, {
        sourceUrl: url,
        fetchedAt,
        rawKey,
        query: { ...query, page },
      });
      if (record) records.push(record);
    }

    if (payload.results.length === 0) break;
    if (payload.totalPages !== null && page >= payload.totalPages) break;
  }

  const entry: LedgerEntry = {
    schemaVersion: LEDGER_SCHEMA_VERSION,
    searchUrl: identityUrl,
    ...query,
    fetchedAt: new Date().toISOString(),
    pagesFetched,
    totalResultsReported,
    totalPagesReported,
    records,
  };
  await putJson(sink, ledgerKey(identityUrl), entry);

  return {
    ...query,
    records,
    pagesFetched,
    requestsMade,
    totalResultsReported,
    totalPagesReported,
    fromLedger: false,
    latencyMs,
    truncatedByEndpointCeiling:
      totalPagesReported !== null &&
      totalPagesReported >= MAX_PAGES_PER_SEARCH &&
      (totalResultsReported ?? 0) > records.length,
  };
}

/**
 * Deduplicates by BBB record id, keeping the first sighting and collecting the rest of the
 * names that id answered to into `alsoKnownAs`.
 *
 * Merging the names rather than discarding the later sighting is the point. Keeping only the
 * first cost real matches: the seed sweep sees `3MG Solutions LLC`, the contractor lookup
 * sees the same id as `3MG Roofing & Solar`, and the permit says `3MG ROOFING` — so throwing
 * away the second name threw away the only name that could be joined.
 */
export function dedupeBusinesses(records: readonly BbbBusinessRecord[]): BbbBusinessRecord[] {
  const seen = new Map<string, BbbBusinessRecord>();
  for (const record of records) {
    const existing = seen.get(record.bbbRecordId);
    if (!existing) {
      seen.set(record.bbbRecordId, { ...record, alsoKnownAs: [...record.alsoKnownAs] });
      continue;
    }
    for (const name of [record.businessName, ...record.alsoKnownAs]) {
      if (name !== existing.businessName && !existing.alsoKnownAs.includes(name)) {
        existing.alsoKnownAs.push(name);
      }
    }
  }
  return [...seen.values()];
}
