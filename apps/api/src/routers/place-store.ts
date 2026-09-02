/**
 * The published Overture places table, held in memory for the life of a Lambda container.
 *
 * 26k county-clipped rows fit as ordinary objects — unlike the 181k parcel snapshot, which
 * had to be columnar to stay inside the function. The table is resolved through
 * `publish/places/current.json`, never a hardcoded release id.
 *
 * This is a location directory, not a corporate registry. A place has coordinates and a
 * category; it does not have officers or a filing date. Conflating the two is what made
 * Sunbiz look interchangeable with this source, and it is not.
 */
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { parquetReadObjects } from 'hyparquet';
import { compressors } from 'hyparquet-compressors';
import { z } from 'zod';
import { logger } from '../observability';
import { ROOFING_TAXONOMY_PATH } from '../places/config';
import { currentPointerKey } from '../places/storage';

const BUCKET = process.env.DATA_BUCKET_NAME ?? '';
const POINTER_TTL_MS = 10 * 60 * 1000;

const s3 = new S3Client({});

const COLUMNS = [
  'gers_id',
  'name',
  'taxonomy_primary',
  'taxonomy_hierarchy',
  'basic_category',
  'confidence',
  'confidence_band',
  'latitude',
  'longitude',
  'jurisdiction',
  'address_freeform',
  'address_locality',
  'address_postcode',
  'address_region',
  'locality_matches_jurisdiction',
  'operating_status',
  'websites',
  'phones',
  'emails',
  'socials',
  'brand_name',
  'source_datasets',
  'overture_release',
  'source_url',
  'first_seen_release',
  'last_seen_release',
] as const;

export const PlacesPointer = z.object({
  release: z.string().min(1),
  runId: z.string().min(1),
  publishedAt: z.string().min(1),
  businessLocations: z.number().int().nonnegative().optional(),
  roofingPlaces: z.number().int().nonnegative().optional(),
  contentFingerprint: z.string().optional(),
  table: z.string().min(1),
  roofingMatches: z.string().optional(),
});
export type PlacesPointer = z.infer<typeof PlacesPointer>;

export interface PlaceRoofingJoin {
  permitMatched: boolean;
  permitContractorName: string | null;
  permitMatchTier: string | null;
  permitMatchConfidence: number;
  permitCount: number | null;
  bbbMatched: boolean;
  bbbPath: string | null;
  bbbBusinessName: string | null;
  bbbRating: string | null;
  bbbMatchConfidence: number;
  bbbProfileUrl: string | null;
}

export interface PlaceRecord {
  gersId: string;
  name: string | null;
  displayTitle: string;
  brandName: string | null;
  taxonomyPrimary: string | null;
  taxonomyHierarchy: string | null;
  basicCategory: string | null;
  confidence: number | null;
  confidenceBand: string | null;
  latitude: number | null;
  longitude: number | null;
  jurisdiction: string | null;
  addressFreeform: string | null;
  addressLocality: string | null;
  addressPostcode: string | null;
  addressRegion: string | null;
  localityMatchesJurisdiction: boolean | null;
  operatingStatus: string | null;
  websites: string[];
  phones: string[];
  emails: string[];
  socials: string[];
  sourceDatasets: string[];
  overtureRelease: string | null;
  sourceUrl: string | null;
  firstSeenRelease: string | null;
  lastSeenRelease: string | null;
  isRoofing: boolean;
  searchKey: string;
  roofing: PlaceRoofingJoin | null;
}

export interface PlaceStore {
  pointer: PlacesPointer;
  places: PlaceRecord[];
  byGersId: Map<string, PlaceRecord>;
  jurisdictions: { value: string; count: number }[];
  categories: { value: string; count: number }[];
  statuses: { value: string; count: number }[];
  roofingCount: number;
  unnamedCount: number;
  loadMs: number;
  fetchMs: number;
  parseMs: number;
  readyAt: string;
}

export const PLACE_SORT_KEYS = ['name_asc', 'confidence_desc', 'category_asc'] as const;
export type PlaceSortKey = (typeof PLACE_SORT_KEYS)[number];

export interface PlaceFilters {
  q?: string;
  jurisdiction?: string;
  category?: string;
  status?: string;
  roofingOnly?: boolean;
}

async function getBytes(key: string): Promise<Uint8Array> {
  const response = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  const bytes = await response.Body?.transformToByteArray();
  if (!bytes) throw new Error(`s3://${BUCKET}/${key} returned no body`);
  return bytes;
}

async function getBytesIfPresent(key: string): Promise<Uint8Array | null> {
  try {
    return await getBytes(key);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error.name === 'NoSuchKey' || error.name === 'NotFound')
  );
}

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function objectKey(raw: string): string {
  const prefix = `s3://${BUCKET}/`;
  return raw.startsWith(prefix) ? raw.slice(prefix.length) : raw.replace(/^s3:\/\/[^/]+\//, '');
}

function toText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text === '' ? null : text;
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function toBoolean(value: unknown): boolean | null {
  if (value === true || value === false) return value;
  return null;
}

function toStringList(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) {
    return value
      .map((entry) => (entry === null || entry === undefined ? '' : String(entry).trim()))
      .filter((entry) => entry !== '');
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return [];
    if (trimmed.startsWith('[')) {
      try {
        return toStringList(JSON.parse(trimmed) as unknown);
      } catch {
        return [trimmed];
      }
    }
    return [trimmed];
  }
  return [];
}

function displayTitleFor(gersId: string, name: string | null, brand: string | null): string {
  return name ?? brand ?? `Place ${gersId}`;
}

function facetCounts(values: (string | null)[]): { value: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const value of values) {
    if (value === null || value === '') continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

function parseRoofingMatch(raw: unknown): { gersId: string; join: PlaceRoofingJoin } | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const row = raw as Record<string, unknown>;
  const gersId = toText(row.gersId);
  if (gersId === null) return null;
  return {
    gersId,
    join: {
      permitMatched: row.permitMatched === true,
      permitContractorName: toText(row.permitContractorName),
      permitMatchTier: toText(row.permitMatchTier),
      permitMatchConfidence: toNumber(row.permitMatchConfidence) ?? 0,
      permitCount: toNumber(row.permitCount),
      bbbMatched: row.bbbMatched === true,
      bbbPath: toText(row.bbbPath),
      bbbBusinessName: toText(row.bbbBusinessName),
      bbbRating: toText(row.bbbRating),
      bbbMatchConfidence: toNumber(row.bbbMatchConfidence) ?? 0,
      bbbProfileUrl: toText(row.bbbProfileUrl),
    },
  };
}

export function placeFromParquet(
  record: Record<string, unknown>,
  roofing: PlaceRoofingJoin | null,
): PlaceRecord | null {
  const gersId = toText(record.gers_id);
  if (gersId === null) return null;

  const name = toText(record.name);
  const brandName = toText(record.brand_name);
  const taxonomyHierarchy = toText(record.taxonomy_hierarchy);
  const addressFreeform = toText(record.address_freeform);
  const addressLocality = toText(record.address_locality);
  const basicCategory = toText(record.basic_category);
  const taxonomyPrimary = toText(record.taxonomy_primary);
  const isRoofing = taxonomyHierarchy === ROOFING_TAXONOMY_PATH;

  const searchKey = [
    gersId,
    name ?? '',
    brandName ?? '',
    addressFreeform ?? '',
    addressLocality ?? '',
    toText(record.address_postcode) ?? '',
    basicCategory ?? '',
    taxonomyPrimary ?? '',
    taxonomyHierarchy ?? '',
  ]
    .join(' ')
    .toLowerCase();

  return {
    gersId,
    name,
    displayTitle: displayTitleFor(gersId, name, brandName),
    brandName,
    taxonomyPrimary,
    taxonomyHierarchy,
    basicCategory,
    confidence: toNumber(record.confidence),
    confidenceBand: toText(record.confidence_band),
    latitude: toNumber(record.latitude),
    longitude: toNumber(record.longitude),
    jurisdiction: toText(record.jurisdiction),
    addressFreeform,
    addressLocality,
    addressPostcode: toText(record.address_postcode),
    addressRegion: toText(record.address_region),
    localityMatchesJurisdiction: toBoolean(record.locality_matches_jurisdiction),
    operatingStatus: toText(record.operating_status),
    websites: toStringList(record.websites),
    phones: toStringList(record.phones),
    emails: toStringList(record.emails),
    socials: toStringList(record.socials),
    sourceDatasets: toStringList(record.source_datasets),
    overtureRelease: toText(record.overture_release),
    sourceUrl: toText(record.source_url),
    firstSeenRelease: toText(record.first_seen_release),
    lastSeenRelease: toText(record.last_seen_release),
    isRoofing,
    searchKey,
    roofing,
  };
}

export function buildPlaceStore(
  pointer: PlacesPointer,
  records: Record<string, unknown>[],
  matches: Map<string, PlaceRoofingJoin>,
  timings: { loadMs: number; fetchMs: number; parseMs: number },
): PlaceStore {
  const places: PlaceRecord[] = [];
  const byGersId = new Map<string, PlaceRecord>();

  for (const record of records) {
    const place = placeFromParquet(record, matches.get(String(record.gers_id ?? '')) ?? null);
    if (place === null) continue;
    places.push(place);
    byGersId.set(place.gersId, place);
  }

  return {
    pointer,
    places,
    byGersId,
    jurisdictions: facetCounts(places.map((place) => place.jurisdiction)),
    categories: facetCounts(places.map((place) => place.basicCategory)),
    statuses: facetCounts(places.map((place) => place.operatingStatus)),
    roofingCount: places.filter((place) => place.isRoofing).length,
    unnamedCount: places.filter((place) => place.name === null).length,
    readyAt: new Date().toISOString(),
    ...timings,
  };
}

function matchesFilters(place: PlaceRecord, filters: PlaceFilters): boolean {
  if (filters.q !== undefined && filters.q !== '') {
    if (!place.searchKey.includes(filters.q.toLowerCase())) return false;
  }
  if (filters.jurisdiction !== undefined && filters.jurisdiction !== '') {
    if (place.jurisdiction !== filters.jurisdiction) return false;
  }
  if (filters.category !== undefined && filters.category !== '') {
    if (place.basicCategory !== filters.category) return false;
  }
  if (filters.status !== undefined && filters.status !== '') {
    if (place.operatingStatus !== filters.status) return false;
  }
  if (filters.roofingOnly === true && !place.isRoofing) return false;
  return true;
}

function comparePlaces(a: PlaceRecord, b: PlaceRecord, sort: PlaceSortKey): number {
  if (sort === 'confidence_desc') {
    const left = a.confidence;
    const right = b.confidence;
    if (left === null) return right === null ? 0 : 1;
    if (right === null) return -1;
    return right - left || a.displayTitle.localeCompare(b.displayTitle);
  }
  if (sort === 'category_asc') {
    const left = a.basicCategory ?? '';
    const right = b.basicCategory ?? '';
    return left.localeCompare(right) || a.displayTitle.localeCompare(b.displayTitle);
  }
  return a.displayTitle.localeCompare(b.displayTitle) || a.gersId.localeCompare(b.gersId);
}

export interface PlaceSearchResult {
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
  rows: PlaceRecord[];
  tookMs: number;
}

export function searchPlaces(
  store: PlaceStore,
  filters: PlaceFilters,
  sort: PlaceSortKey,
  page: number,
  pageSize: number,
): PlaceSearchResult {
  const startedAt = Date.now();
  const matched = store.places.filter((place) => matchesFilters(place, filters));
  matched.sort((a, b) => comparePlaces(a, b, sort));

  const total = matched.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(page, 1), pageCount);
  const start = (safePage - 1) * pageSize;

  return {
    total,
    page: safePage,
    pageSize,
    pageCount,
    rows: matched.slice(start, start + pageSize),
    tookMs: Date.now() - startedAt,
  };
}

export function getPlace(store: PlaceStore, gersId: string): PlaceRecord | null {
  return store.byGersId.get(gersId) ?? null;
}

async function loadStore(pointer: PlacesPointer): Promise<PlaceStore> {
  const startedAt = Date.now();
  const fetchStarted = Date.now();
  const [tableBytes, matchBytes] = await Promise.all([
    getBytes(objectKey(pointer.table)),
    pointer.roofingMatches !== undefined
      ? getBytesIfPresent(objectKey(pointer.roofingMatches))
      : Promise.resolve(null),
  ]);
  const fetchMs = Date.now() - fetchStarted;

  const parseStarted = Date.now();
  const records = (await parquetReadObjects({
    file: asArrayBuffer(tableBytes),
    compressors,
    columns: [...COLUMNS],
  })) as Record<string, unknown>[];

  const matches = new Map<string, PlaceRoofingJoin>();
  if (matchBytes !== null) {
    const text = new TextDecoder().decode(matchBytes);
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      try {
        const parsed = parseRoofingMatch(JSON.parse(line) as unknown);
        if (parsed !== null) matches.set(parsed.gersId, parsed.join);
      } catch {
        // A single corrupt join line must not blank the directory.
      }
    }
  }
  const parseMs = Date.now() - parseStarted;

  const store = buildPlaceStore(pointer, records, matches, {
    loadMs: Date.now() - startedAt,
    fetchMs,
    parseMs,
  });

  logger.info('Loaded places snapshot', {
    runId: pointer.runId,
    release: pointer.release,
    places: store.places.length,
    roofing: store.roofingCount,
    loadMs: store.loadMs,
  });

  return store;
}

let cache: { runId: string; store: Promise<PlaceStore>; pointerCheckedAt: number } | null = null;

export async function readPlacesPointer(): Promise<PlacesPointer> {
  const bytes = await getBytes(currentPointerKey());
  return PlacesPointer.parse(JSON.parse(new TextDecoder().decode(bytes)));
}

export async function getPlaceStore(): Promise<PlaceStore> {
  const now = Date.now();
  if (cache && now - cache.pointerCheckedAt < POINTER_TTL_MS) return cache.store;

  const pointer = await readPlacesPointer();
  if (cache && cache.runId === pointer.runId) {
    cache.pointerCheckedAt = now;
    return cache.store;
  }

  const entry = { runId: pointer.runId, store: loadStore(pointer), pointerCheckedAt: now };
  cache = entry;
  entry.store.catch((error: unknown) => {
    logger.error('Failed to load places snapshot', { runId: pointer.runId, error });
    if (cache === entry) cache = null;
  });
  return entry.store;
}
