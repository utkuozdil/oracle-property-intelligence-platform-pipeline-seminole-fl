import { GetObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { parquetReadObjects } from 'hyparquet';
import { z } from 'zod';
import { logger } from '../observability';

/**
 * The parcel snapshot, held in memory for the life of a Lambda container.
 *
 * Three decisions worth stating, because each is load-bearing.
 *
 * **Parquet is read with `hyparquet`, a pure-JS reader.** A native reader would need a
 * platform-specific binary in the bundle, which this repository's shared Lambda construct
 * has no seam for. `hyparquet` bundles as ordinary JavaScript and parses the full snapshot
 * in about 1.5 s.
 *
 * **Rows are transposed into columns immediately and the row objects are dropped.** Keeping
 * 181,218 row objects alive measured at 785 MB of heap, which does not fit this function.
 * The same data as typed arrays and dictionary-coded strings sits comfortably inside it,
 * because the per-object and per-key overhead is what dominates, not the values.
 *
 * **The snapshot is resolved through `publish/current.json`, never a hardcoded id.** Snapshot
 * ids are run-scoped and change on every publish.
 */

const BUCKET = process.env.DATA_BUCKET_NAME ?? '';

/** The only data-lake key the serving tier is allowed to know. */
const PUBLISH_POINTER_KEY = 'publish/current.json';

/** Parallel S3 GETs. The 56 objects average ~700 KB, so ten in flight saturates the link. */
const FETCH_CONCURRENCY = 10;

/** How long a warm container trusts its pointer before re-reading it. Data changes nightly. */
const POINTER_TTL_MS = 10 * 60 * 1000;

const s3 = new S3Client({});

/** Sentinel for a missing integer. `Int32Array` has no null, and every real value is > this. */
const INT_NULL = -2147483648;

export const PublishPointer = z.object({
  runId: z.string().min(1),
  county: z.string().min(1),
  snapshotPrefix: z.string().min(1),
  parcelCount: z.number().int().nonnegative(),
  partitionCount: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
  publishedAt: z.string().min(1),
});
export type PublishPointer = z.infer<typeof PublishPointer>;

/** Columns the UI reads. Naming them keeps unused columns out of heap entirely. */
const COLUMNS = [
  'parcel_id',
  'owner_name',
  'primary_address',
  'mailing_city_state_zip',
  'property_type',
  'dor_code',
  'jurisdiction',
  'subdivision',
  'year_built',
  'max_effective_year_blt',
  'roof_age',
  'years_since_sale',
  'last_sale_date',
  'last_sale_amount',
  'sale_count',
  'total_just_value',
  'assessed_value',
  'taxable_value',
  'annual_tax_total',
  'total_living_area',
  'total_bedrooms',
  'total_bathrooms',
  'has_pool',
  'has_fireplace',
  'has_homestead',
  'has_building',
  'demolition_flag',
  'owner_out_of_area',
  'latitude',
  'longitude',
  'mailing_street',
] as const;

/** Bit positions inside the packed flag byte. */
const FLAG = {
  pool: 1,
  fireplace: 2,
  homestead: 4,
  building: 8,
  demolition: 16,
  outOfArea: 32,
} as const;

async function getBytes(key: string): Promise<Uint8Array> {
  const response = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  const bytes = await response.Body?.transformToByteArray();
  if (!bytes) throw new Error(`s3://${BUCKET}/${key} returned no body`);
  return bytes;
}

export async function readPublishPointer(): Promise<PublishPointer> {
  const bytes = await getBytes(PUBLISH_POINTER_KEY);
  return PublishPointer.parse(JSON.parse(new TextDecoder().decode(bytes)));
}

async function listSnapshotKeys(pointer: PublishPointer): Promise<string[]> {
  const prefix = pointer.snapshotPrefix.replace(`s3://${BUCKET}/`, '');
  const keys: string[] = [];
  let continuationToken: string | undefined;
  do {
    const page = await s3.send(
      new ListObjectsV2Command({
        Bucket: BUCKET,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    );
    for (const object of page.Contents ?? []) {
      if (object.Key?.endsWith('.parquet')) keys.push(object.Key);
    }
    continuationToken = page.NextContinuationToken;
  } while (continuationToken);
  return keys;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  async function pump(): Promise<void> {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index] as T, index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, pump));
  return results;
}

/** Low-cardinality string column stored as codes into a shared dictionary. */
interface Dictionary {
  codes: Uint16Array;
  values: (string | null)[];
}

class DictionaryBuilder {
  private readonly index = new Map<string | null, number>();
  readonly values: (string | null)[] = [];
  readonly codes: Uint16Array;

  constructor(size: number) {
    this.codes = new Uint16Array(size);
  }

  set(row: number, value: string | null): void {
    let code = this.index.get(value);
    if (code === undefined) {
      code = this.values.length;
      this.values.push(value);
      this.index.set(value, code);
    }
    this.codes[row] = code;
  }

  build(): Dictionary {
    return { codes: this.codes, values: this.values };
  }
}

export interface ParcelStore {
  pointer: PublishPointer;
  count: number;
  /** Distinct jurisdictions with their parcel counts, descending. */
  jurisdictions: { value: string; count: number }[];
  /** Parcels where `primary_address` is absent; the UI titles these `Parcel <id>`. */
  parcelsWithoutAddress: number;
  /** Parcels carrying a usable centroid. Radius search is only honest about this subset. */
  withCoordinates: number;
  /** Parcels carrying an owner name, which is what the owner entity view can resolve. */
  withOwnerName: number;
  /** Bounding box of every parcel centroid, so the UI can state the searchable extent. */
  bounds: { minLat: number; maxLat: number; minLon: number; maxLon: number } | null;
  loadMs: number;
  fetchMs: number;
  parseMs: number;
  readyAt: string;
  heapUsedMb: number;

  parcelId: string[];
  ownerName: (string | null)[];
  primaryAddress: (string | null)[];
  mailingCityStateZip: (string | null)[];
  mailingStreet: (string | null)[];
  subdivision: (string | null)[];
  propertyType: Dictionary;
  dorCode: Dictionary;
  jurisdiction: Dictionary;
  /** Lowercased `parcel_id owner_name primary_address`, so text search is one scan. */
  searchKey: string[];

  yearBuilt: Int32Array;
  maxEffectiveYearBlt: Int32Array;
  roofAge: Int32Array;
  yearsSinceSale: Int32Array;
  saleCount: Int32Array;

  lastSaleDateMs: Float64Array;
  lastSaleAmount: Float64Array;
  totalJustValue: Float64Array;
  assessedValue: Float64Array;
  taxableValue: Float64Array;
  annualTaxTotal: Float64Array;
  totalLivingArea: Float64Array;
  totalBedrooms: Float64Array;
  totalBathrooms: Float64Array;
  latitude: Float64Array;
  longitude: Float64Array;

  flags: Uint8Array;
  /** Parcel id to row offset, for the detail view. */
  byParcelId: Map<string, number>;
  /**
   * Normalised owner name to the rows that owner holds. Built on the first owner request
   * rather than at load time: it costs ~9 MB for 150k distinct owners, which is worth
   * paying only in containers that actually serve the owner views.
   */
  ownerIndex: Map<string, Int32Array> | null;
}

function toInt(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'bigint') return Number(value);
  return INT_NULL;
}

function toFloat(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'bigint') return Number(value);
  return Number.NaN;
}

function toText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** hyparquet decodes a DATE logical type to a `Date`; older writers may emit epoch days. */
function toEpochMs(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number' && Number.isFinite(value)) return value * 86400000;
  if (typeof value === 'bigint') return Number(value) * 86400000;
  return Number.NaN;
}

async function loadStore(pointer: PublishPointer): Promise<ParcelStore> {
  const startedAt = Date.now();

  const keys = await listSnapshotKeys(pointer);
  if (keys.length === 0) {
    throw new Error(
      `snapshot ${pointer.runId} has no Parquet objects at ${pointer.snapshotPrefix}`,
    );
  }

  const fetchStartedAt = Date.now();
  const buffers = await mapWithConcurrency(keys, FETCH_CONCURRENCY, getBytes);
  const fetchMs = Date.now() - fetchStartedAt;

  const parseStartedAt = Date.now();
  const size = pointer.parcelCount;
  const store = {
    parcelId: new Array<string>(size),
    ownerName: new Array<string | null>(size),
    primaryAddress: new Array<string | null>(size),
    mailingCityStateZip: new Array<string | null>(size),
    mailingStreet: new Array<string | null>(size),
    subdivision: new Array<string | null>(size),
    searchKey: new Array<string>(size),
    yearBuilt: new Int32Array(size),
    maxEffectiveYearBlt: new Int32Array(size),
    roofAge: new Int32Array(size),
    yearsSinceSale: new Int32Array(size),
    saleCount: new Int32Array(size),
    lastSaleDateMs: new Float64Array(size),
    lastSaleAmount: new Float64Array(size),
    totalJustValue: new Float64Array(size),
    assessedValue: new Float64Array(size),
    taxableValue: new Float64Array(size),
    annualTaxTotal: new Float64Array(size),
    totalLivingArea: new Float64Array(size),
    totalBedrooms: new Float64Array(size),
    totalBathrooms: new Float64Array(size),
    latitude: new Float64Array(size),
    longitude: new Float64Array(size),
    flags: new Uint8Array(size),
  };
  const propertyType = new DictionaryBuilder(size);
  const dorCode = new DictionaryBuilder(size);
  const jurisdiction = new DictionaryBuilder(size);
  const byParcelId = new Map<string, number>();

  let row = 0;
  let parcelsWithoutAddress = 0;

  for (let fileIndex = 0; fileIndex < buffers.length; fileIndex += 1) {
    const bytes = buffers[fileIndex] as Uint8Array;
    const file = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    const rows = (await parquetReadObjects({ file, columns: [...COLUMNS] })) as Record<
      string,
      unknown
    >[];

    for (const record of rows) {
      if (row >= size) break;

      const id = String(record.parcel_id ?? '');
      const owner = toText(record.owner_name);
      const address = toText(record.primary_address);
      if (address === null) parcelsWithoutAddress += 1;

      store.parcelId[row] = id;
      store.ownerName[row] = owner;
      store.primaryAddress[row] = address;
      store.mailingCityStateZip[row] = toText(record.mailing_city_state_zip);
      store.mailingStreet[row] = toText(record.mailing_street);
      store.subdivision[row] = toText(record.subdivision);
      store.searchKey[row] = `${id} ${owner ?? ''} ${address ?? ''}`.toLowerCase();

      propertyType.set(row, toText(record.property_type));
      dorCode.set(row, toText(record.dor_code));
      jurisdiction.set(row, toText(record.jurisdiction));

      store.yearBuilt[row] = toInt(record.year_built);
      store.maxEffectiveYearBlt[row] = toInt(record.max_effective_year_blt);
      store.roofAge[row] = toInt(record.roof_age);
      store.yearsSinceSale[row] = toInt(record.years_since_sale);
      store.saleCount[row] = toInt(record.sale_count);

      store.lastSaleDateMs[row] = toEpochMs(record.last_sale_date);
      store.lastSaleAmount[row] = toFloat(record.last_sale_amount);
      store.totalJustValue[row] = toFloat(record.total_just_value);
      store.assessedValue[row] = toFloat(record.assessed_value);
      store.taxableValue[row] = toFloat(record.taxable_value);
      store.annualTaxTotal[row] = toFloat(record.annual_tax_total);
      store.totalLivingArea[row] = toFloat(record.total_living_area);
      store.totalBedrooms[row] = toFloat(record.total_bedrooms);
      store.totalBathrooms[row] = toFloat(record.total_bathrooms);
      store.latitude[row] = toFloat(record.latitude);
      store.longitude[row] = toFloat(record.longitude);

      let flags = 0;
      if (record.has_pool === true) flags |= FLAG.pool;
      if (record.has_fireplace === true) flags |= FLAG.fireplace;
      if (record.has_homestead === true) flags |= FLAG.homestead;
      if (record.has_building === true) flags |= FLAG.building;
      if (record.demolition_flag === true) flags |= FLAG.demolition;
      if (record.owner_out_of_area === true) flags |= FLAG.outOfArea;
      store.flags[row] = flags;

      byParcelId.set(id, row);
      row += 1;
    }
  }

  const parseMs = Date.now() - parseStartedAt;

  const jurisdictionCounts = new Map<string, number>();
  let withCoordinates = 0;
  let withOwnerName = 0;
  let minLat = Number.POSITIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;
  let minLon = Number.POSITIVE_INFINITY;
  let maxLon = Number.NEGATIVE_INFINITY;

  for (let i = 0; i < row; i += 1) {
    const value = jurisdiction.values[jurisdiction.codes[i] as number] ?? 'Unknown';
    jurisdictionCounts.set(value, (jurisdictionCounts.get(value) ?? 0) + 1);

    if (store.ownerName[i] !== null) withOwnerName += 1;

    const latitude = store.latitude[i] as number;
    const longitude = store.longitude[i] as number;
    if (!Number.isNaN(latitude) && !Number.isNaN(longitude)) {
      withCoordinates += 1;
      if (latitude < minLat) minLat = latitude;
      if (latitude > maxLat) maxLat = latitude;
      if (longitude < minLon) minLon = longitude;
      if (longitude > maxLon) maxLon = longitude;
    }
  }

  const result: ParcelStore = {
    ...store,
    pointer,
    count: row,
    propertyType: propertyType.build(),
    dorCode: dorCode.build(),
    jurisdiction: jurisdiction.build(),
    byParcelId,
    ownerIndex: null,
    parcelsWithoutAddress,
    withCoordinates,
    withOwnerName,
    bounds: withCoordinates === 0 ? null : { minLat, maxLat, minLon, maxLon },
    jurisdictions: [...jurisdictionCounts.entries()]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count),
    fetchMs,
    parseMs,
    loadMs: Date.now() - startedAt,
    readyAt: new Date().toISOString(),
    heapUsedMb: Math.round(process.memoryUsage().heapUsed / 1e6),
  };

  logger.info('Parcel snapshot ready', {
    runId: pointer.runId,
    objects: keys.length,
    parcels: result.count,
    withCoordinates,
    fetchMs,
    parseMs,
    loadMs: result.loadMs,
    heapUsedMb: result.heapUsedMb,
  });

  return result;
}

let cache: { runId: string; store: Promise<ParcelStore>; pointerCheckedAt: number } | null = null;

/** The snapshot this container already holds, or `null`. Never starts a load. */
let resolved: ParcelStore | null = null;

/**
 * The snapshot only if it is already resident in this container.
 *
 * Callers that merely want to enrich a response with coverage figures use this, so a
 * metadata view never pays a 5 s cold-start Parquet parse it does not need.
 */
export function peekParcelStore(): ParcelStore | null {
  return resolved;
}

/**
 * The in-memory snapshot for the currently published run.
 *
 * A warm container answers straight from the cached promise. The pointer is only re-read
 * after {@link POINTER_TTL_MS}, and a failed load clears the cache so the next request
 * retries rather than being served a poisoned promise for the container's whole life.
 */
export async function getParcelStore(): Promise<ParcelStore> {
  const now = Date.now();
  if (cache && now - cache.pointerCheckedAt < POINTER_TTL_MS) return cache.store;

  const pointer = await readPublishPointer();
  if (cache && cache.runId === pointer.runId) {
    cache.pointerCheckedAt = now;
    return cache.store;
  }

  const entry = { runId: pointer.runId, store: loadStore(pointer), pointerCheckedAt: now };
  cache = entry;
  entry.store
    .then((store) => {
      if (cache === entry) resolved = store;
    })
    .catch((error: unknown) => {
      logger.error('Failed to load parcel snapshot', { runId: pointer.runId, error });
      if (cache === entry) cache = null;
    });
  return entry.store;
}

// ---------------------------------------------------------------------------
// Query engine
// ---------------------------------------------------------------------------

export const SORT_KEYS = [
  'relevance',
  'roof_age_desc',
  'total_just_value_desc',
  'total_just_value_asc',
  'years_since_sale_desc',
  'year_built_asc',
  'year_built_desc',
  'last_sale_date_desc',
] as const;
export type SortKey = (typeof SORT_KEYS)[number];

export interface ParcelFilters {
  q?: string;
  jurisdiction?: string;
  roofAgeMin?: number;
  justValueMin?: number;
  justValueMax?: number;
  yearBuiltMin?: number;
  yearBuiltMax?: number;
  yearsSinceSaleMin?: number;
  ownerOutOfArea?: boolean;
}

export interface ParcelSummary {
  parcelId: string;
  /** Never blank: falls back to `Parcel <parcel_id>` when `primary_address` is absent. */
  displayTitle: string;
  hasAddress: boolean;
  ownerName: string | null;
  jurisdiction: string | null;
  propertyType: string | null;
  yearBuilt: number | null;
  roofAge: number | null;
  totalJustValue: number | null;
  lastSaleDate: string | null;
  yearsSinceSale: number | null;
  ownerOutOfArea: boolean;
}

const nullableInt = (value: number): number | null => (value === INT_NULL ? null : value);
const nullableFloat = (value: number): number | null => (Number.isNaN(value) ? null : value);
const isoDate = (ms: number): string | null =>
  Number.isNaN(ms) ? null : (new Date(ms).toISOString().slice(0, 10) as string);

export function displayTitleFor(parcelId: string, address: string | null): string {
  return address ?? `Parcel ${parcelId}`;
}

/**
 * A row predicate for the attribute filters, shared by the full scan and radius search so
 * both apply identical semantics. Returns `null` when the filters can match nothing.
 */
function buildPredicate(
  store: ParcelStore,
  filters: ParcelFilters,
): ((i: number) => boolean) | null {
  const needle = filters.q?.trim().toLowerCase() ?? '';
  const jurisdictionCode =
    filters.jurisdiction === undefined || filters.jurisdiction === ''
      ? -1
      : store.jurisdiction.values.indexOf(filters.jurisdiction);

  // A jurisdiction that is not in the dictionary matches nothing, rather than everything.
  if (filters.jurisdiction && jurisdictionCode === -1) return null;

  return (i: number): boolean => {
    if (jurisdictionCode !== -1 && store.jurisdiction.codes[i] !== jurisdictionCode) return false;

    if (filters.roofAgeMin !== undefined) {
      const roofAge = store.roofAge[i] as number;
      if (roofAge === INT_NULL || roofAge < filters.roofAgeMin) return false;
    }
    if (filters.yearsSinceSaleMin !== undefined) {
      const years = store.yearsSinceSale[i] as number;
      if (years === INT_NULL || years < filters.yearsSinceSaleMin) return false;
    }
    if (
      filters.justValueMin !== undefined &&
      (store.totalJustValue[i] as number) < filters.justValueMin
    )
      return false;
    if (
      filters.justValueMax !== undefined &&
      (store.totalJustValue[i] as number) > filters.justValueMax
    )
      return false;
    if (filters.yearBuiltMin !== undefined) {
      const built = store.yearBuilt[i] as number;
      if (built === INT_NULL || built < filters.yearBuiltMin) return false;
    }
    if (filters.yearBuiltMax !== undefined) {
      const built = store.yearBuilt[i] as number;
      if (built === INT_NULL || built > filters.yearBuiltMax) return false;
    }
    if (filters.ownerOutOfArea !== undefined) {
      const isOutOfArea = ((store.flags[i] as number) & FLAG.outOfArea) !== 0;
      if (isOutOfArea !== filters.ownerOutOfArea) return false;
    }
    if (needle !== '' && !(store.searchKey[i] as string).includes(needle)) return false;

    return true;
  };
}

function matchRows(store: ParcelStore, filters: ParcelFilters): Int32Array {
  const matches = new Int32Array(store.count);
  const accepts = buildPredicate(store, filters);
  if (accepts === null) return new Int32Array(0);

  let found = 0;
  for (let i = 0; i < store.count; i += 1) {
    if (!accepts(i)) continue;
    matches[found] = i;
    found += 1;
  }

  return matches.subarray(0, found);
}

/** Sort comparators. Nulls always sort last, whichever direction the key runs. */
function sortMatches(store: ParcelStore, matches: Int32Array, sort: SortKey): Int32Array {
  if (sort === 'relevance') return matches;

  const ordered = Array.from(matches);
  const descInt = (column: Int32Array) => (a: number, b: number) => {
    const left = column[a] as number;
    const right = column[b] as number;
    if (left === INT_NULL) return right === INT_NULL ? 0 : 1;
    if (right === INT_NULL) return -1;
    return right - left;
  };
  const ascInt = (column: Int32Array) => (a: number, b: number) => {
    const left = column[a] as number;
    const right = column[b] as number;
    if (left === INT_NULL) return right === INT_NULL ? 0 : 1;
    if (right === INT_NULL) return -1;
    return left - right;
  };
  const byFloat = (column: Float64Array, direction: 1 | -1) => (a: number, b: number) => {
    const left = column[a] as number;
    const right = column[b] as number;
    if (Number.isNaN(left)) return Number.isNaN(right) ? 0 : 1;
    if (Number.isNaN(right)) return -1;
    return direction * (left - right);
  };

  const comparators: Record<Exclude<SortKey, 'relevance'>, (a: number, b: number) => number> = {
    roof_age_desc: descInt(store.roofAge),
    years_since_sale_desc: descInt(store.yearsSinceSale),
    year_built_asc: ascInt(store.yearBuilt),
    year_built_desc: descInt(store.yearBuilt),
    total_just_value_desc: byFloat(store.totalJustValue, -1),
    total_just_value_asc: byFloat(store.totalJustValue, 1),
    last_sale_date_desc: byFloat(store.lastSaleDateMs, -1),
  };

  ordered.sort(comparators[sort]);
  return Int32Array.from(ordered);
}

function summaryAt(store: ParcelStore, i: number): ParcelSummary {
  const parcelId = store.parcelId[i] as string;
  const address = store.primaryAddress[i] ?? null;
  return {
    parcelId,
    displayTitle: displayTitleFor(parcelId, address),
    hasAddress: address !== null,
    ownerName: store.ownerName[i] ?? null,
    jurisdiction: store.jurisdiction.values[store.jurisdiction.codes[i] as number] ?? null,
    propertyType: store.propertyType.values[store.propertyType.codes[i] as number] ?? null,
    yearBuilt: nullableInt(store.yearBuilt[i] as number),
    roofAge: nullableInt(store.roofAge[i] as number),
    totalJustValue: nullableFloat(store.totalJustValue[i] as number),
    lastSaleDate: isoDate(store.lastSaleDateMs[i] as number),
    yearsSinceSale: nullableInt(store.yearsSinceSale[i] as number),
    ownerOutOfArea: ((store.flags[i] as number) & FLAG.outOfArea) !== 0,
  };
}

export interface SearchResult {
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
  rows: ParcelSummary[];
  tookMs: number;
}

export function searchParcels(
  store: ParcelStore,
  filters: ParcelFilters,
  sort: SortKey,
  page: number,
  pageSize: number,
): SearchResult {
  const startedAt = Date.now();
  const matches = matchRows(store, filters);
  const total = matches.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(page, 1), pageCount);
  const sorted = sortMatches(store, matches, sort);

  const start = (safePage - 1) * pageSize;
  const rows: ParcelSummary[] = [];
  for (let i = start; i < Math.min(start + pageSize, total); i += 1) {
    rows.push(summaryAt(store, sorted[i] as number));
  }

  return { total, page: safePage, pageSize, pageCount, rows, tookMs: Date.now() - startedAt };
}

export interface ParcelDetail extends ParcelSummary {
  dorCode: string | null;
  subdivision: string | null;
  mailingCityStateZip: string | null;
  maxEffectiveYearBlt: number | null;
  totalLivingArea: number | null;
  totalBedrooms: number | null;
  totalBathrooms: number | null;
  lastSaleAmount: number | null;
  saleCount: number | null;
  assessedValue: number | null;
  taxableValue: number | null;
  annualTaxTotal: number | null;
  latitude: number | null;
  longitude: number | null;
  hasPool: boolean;
  hasFireplace: boolean;
  hasHomestead: boolean;
  hasBuilding: boolean;
  demolitionFlag: boolean;
}

export function getParcelDetail(store: ParcelStore, parcelId: string): ParcelDetail | null {
  const i = store.byParcelId.get(parcelId);
  if (i === undefined) return null;
  const flags = store.flags[i] as number;
  return {
    ...summaryAt(store, i),
    dorCode: store.dorCode.values[store.dorCode.codes[i] as number] ?? null,
    subdivision: store.subdivision[i] ?? null,
    mailingCityStateZip: store.mailingCityStateZip[i] ?? null,
    maxEffectiveYearBlt: nullableInt(store.maxEffectiveYearBlt[i] as number),
    totalLivingArea: nullableFloat(store.totalLivingArea[i] as number),
    totalBedrooms: nullableFloat(store.totalBedrooms[i] as number),
    totalBathrooms: nullableFloat(store.totalBathrooms[i] as number),
    lastSaleAmount: nullableFloat(store.lastSaleAmount[i] as number),
    saleCount: nullableInt(store.saleCount[i] as number),
    assessedValue: nullableFloat(store.assessedValue[i] as number),
    taxableValue: nullableFloat(store.taxableValue[i] as number),
    annualTaxTotal: nullableFloat(store.annualTaxTotal[i] as number),
    latitude: nullableFloat(store.latitude[i] as number),
    longitude: nullableFloat(store.longitude[i] as number),
    hasPool: (flags & FLAG.pool) !== 0,
    hasFireplace: (flags & FLAG.fireplace) !== 0,
    hasHomestead: (flags & FLAG.homestead) !== 0,
    hasBuilding: (flags & FLAG.building) !== 0,
    demolitionFlag: (flags & FLAG.demolition) !== 0,
  };
}

// ---------------------------------------------------------------------------
// Radius search
// ---------------------------------------------------------------------------

/**
 * Radius search around a point.
 *
 * Distance is exact haversine, but it is only computed for parcels inside a
 * latitude/longitude bounding box sized to the radius — a one-mile search touches a few
 * hundred rows rather than 181,218. A bounding box is used rather than the snapshot's
 * `geohash5` partitioning because geohash5 is a Hive partition on the object path, not a
 * column inside the Parquet files, so the in-memory store never sees it. The box is also
 * strictly tighter than a five-character geohash cell, which is roughly 3 mi × 3 mi.
 */
export const EARTH_RADIUS_MILES = 3958.7613;

/** Degrees of latitude per mile. Constant; longitude narrows with the cosine of latitude. */
const MILES_PER_LAT_DEGREE = 69.0546;

export interface GeoPoint {
  lat: number;
  lon: number;
}

export interface BoundingBox {
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
}

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

export function haversineMiles(from: GeoPoint, to: GeoPoint): number {
  const dLat = toRadians(to.lat - from.lat);
  const dLon = toRadians(to.lon - from.lon);
  const fromLat = toRadians(from.lat);
  const toLat = toRadians(to.lat);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(fromLat) * Math.cos(toLat) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function boundingBoxFor(center: GeoPoint, radiusMiles: number): BoundingBox {
  const latDelta = radiusMiles / MILES_PER_LAT_DEGREE;
  // Guard the cosine so a degenerate latitude cannot produce an infinite longitude span.
  const cosLat = Math.max(Math.cos(toRadians(center.lat)), 0.01);
  const lonDelta = radiusMiles / (MILES_PER_LAT_DEGREE * cosLat);
  return {
    minLat: center.lat - latDelta,
    maxLat: center.lat + latDelta,
    minLon: center.lon - lonDelta,
    maxLon: center.lon + lonDelta,
  };
}

export const NEARBY_SORT_KEYS = ['distance_asc', ...SORT_KEYS] as const;
export type NearbySortKey = (typeof NEARBY_SORT_KEYS)[number];

export interface NearbyRow extends ParcelSummary {
  distanceMiles: number;
  latitude: number;
  longitude: number;
}

export interface NearbyResult {
  center: GeoPoint;
  radiusMiles: number;
  boundingBox: BoundingBox;
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
  rows: NearbyRow[];
  /** Parcels whose distance was actually computed, i.e. the bounding-box survivors. */
  candidatesScanned: number;
  /** Parcels excluded because the snapshot carries no centroid for them. */
  withoutCoordinates: number;
  tookMs: number;
}

export function searchNearby(
  store: ParcelStore,
  center: GeoPoint,
  radiusMiles: number,
  filters: ParcelFilters,
  sort: NearbySortKey,
  page: number,
  pageSize: number,
): NearbyResult {
  const startedAt = Date.now();
  const box = boundingBoxFor(center, radiusMiles);
  const accepts = buildPredicate(store, filters);

  const rows: number[] = [];
  const distances = new Map<number, number>();
  let candidatesScanned = 0;

  if (accepts !== null) {
    for (let i = 0; i < store.count; i += 1) {
      const lat = store.latitude[i] as number;
      if (!(lat >= box.minLat && lat <= box.maxLat)) continue;
      const lon = store.longitude[i] as number;
      if (!(lon >= box.minLon && lon <= box.maxLon)) continue;

      candidatesScanned += 1;
      const distance = haversineMiles(center, { lat, lon });
      if (distance > radiusMiles) continue;
      if (!accepts(i)) continue;

      rows.push(i);
      distances.set(i, distance);
    }
  }

  if (sort === 'distance_asc') {
    rows.sort((a, b) => (distances.get(a) as number) - (distances.get(b) as number));
  } else {
    const ordered = sortMatches(store, Int32Array.from(rows), sort as SortKey);
    rows.length = 0;
    rows.push(...ordered);
  }

  const total = rows.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(page, 1), pageCount);
  const start = (safePage - 1) * pageSize;

  const pageRows: NearbyRow[] = [];
  for (let i = start; i < Math.min(start + pageSize, total); i += 1) {
    const row = rows[i] as number;
    pageRows.push({
      ...summaryAt(store, row),
      distanceMiles: distances.get(row) as number,
      latitude: store.latitude[row] as number,
      longitude: store.longitude[row] as number,
    });
  }

  return {
    center,
    radiusMiles,
    boundingBox: box,
    total,
    page: safePage,
    pageSize,
    pageCount,
    rows: pageRows,
    candidatesScanned,
    withoutCoordinates: store.count - store.withCoordinates,
    tookMs: Date.now() - startedAt,
  };
}

export interface ResolvedCentre {
  center: GeoPoint;
  parcelId: string;
  label: string;
  jurisdiction: string | null;
}

/**
 * Resolves free text — an address, a parcel id, an owner name, or a jurisdiction — to a
 * centre point by finding the best matching parcel that carries a centroid.
 *
 * This is deliberately not a geocoder. The county roll is the only place-name authority
 * this pipeline has ingested, so a centre is always an actual parcel centroid and the
 * response names the parcel it came from. Preference order: exact parcel id, then a
 * jurisdiction whose name matches (whose centre is the mean of its parcels), then the
 * first address or owner match.
 */
export function resolveCentre(store: ParcelStore, text: string): ResolvedCentre | null {
  const needle = text.trim().toLowerCase();
  if (needle === '') return null;

  const exactRow = store.byParcelId.get(text.trim());
  if (exactRow !== undefined && hasCoordinates(store, exactRow)) {
    return describeCentre(store, exactRow);
  }

  const jurisdictionCode = store.jurisdiction.values.findIndex(
    (value) => value !== null && value.toLowerCase() === needle,
  );
  if (jurisdictionCode !== -1) {
    let latSum = 0;
    let lonSum = 0;
    let counted = 0;
    let nearestRow = -1;
    for (let i = 0; i < store.count; i += 1) {
      if (store.jurisdiction.codes[i] !== jurisdictionCode || !hasCoordinates(store, i)) continue;
      latSum += store.latitude[i] as number;
      lonSum += store.longitude[i] as number;
      counted += 1;
      if (nearestRow === -1) nearestRow = i;
    }
    if (counted > 0) {
      const centre = { lat: latSum / counted, lon: lonSum / counted };
      return {
        center: centre,
        parcelId: store.parcelId[nearestRow] as string,
        label: `${store.jurisdiction.values[jurisdictionCode] as string} (mean of ${counted.toLocaleString('en-US')} parcel centroids)`,
        jurisdiction: store.jurisdiction.values[jurisdictionCode] ?? null,
      };
    }
  }

  for (let i = 0; i < store.count; i += 1) {
    if (!(store.searchKey[i] as string).includes(needle)) continue;
    if (!hasCoordinates(store, i)) continue;
    return describeCentre(store, i);
  }

  return null;
}

function hasCoordinates(store: ParcelStore, i: number): boolean {
  return !Number.isNaN(store.latitude[i] as number) && !Number.isNaN(store.longitude[i] as number);
}

function describeCentre(store: ParcelStore, i: number): ResolvedCentre {
  const parcelId = store.parcelId[i] as string;
  return {
    center: { lat: store.latitude[i] as number, lon: store.longitude[i] as number },
    parcelId,
    label: displayTitleFor(parcelId, store.primaryAddress[i] ?? null),
    jurisdiction: store.jurisdiction.values[store.jurisdiction.codes[i] as number] ?? null,
  };
}

// ---------------------------------------------------------------------------
// Owner entity
// ---------------------------------------------------------------------------

/**
 * The owner key.
 *
 * Owner names in the roll are free text with inconsistent spacing and punctuation, so an
 * entity is keyed on a normalised form: upper-cased, punctuation dropped, whitespace
 * collapsed. `SMITH, JOHN A.` and `SMITH  JOHN A` therefore resolve to the same owner.
 * This is deliberately conservative — it merges formatting variants only, never
 * different-looking names, because a wrong merge is worse than a missed one.
 */
export function normaliseOwnerKey(name: string): string {
  return name
    .toUpperCase()
    .replace(/[.,;:'"()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getOwnerIndex(store: ParcelStore): Map<string, Int32Array> {
  if (store.ownerIndex !== null) return store.ownerIndex;

  const buckets = new Map<string, number[]>();
  for (let i = 0; i < store.count; i += 1) {
    const owner = store.ownerName[i];
    if (owner === null || owner === undefined) continue;
    const key = normaliseOwnerKey(owner);
    if (key === '') continue;
    const bucket = buckets.get(key);
    if (bucket === undefined) buckets.set(key, [i]);
    else bucket.push(i);
  }

  const index = new Map<string, Int32Array>();
  for (const [key, rows] of buckets) index.set(key, Int32Array.from(rows));
  store.ownerIndex = index;

  logger.info('Owner index built', { owners: index.size, parcels: store.count });
  return index;
}

export interface OwnerProfile {
  /** The normalised key, which is what a URL carries. */
  key: string;
  /** The most frequent spelling in the roll, used as the display name. */
  name: string;
  /** Every distinct spelling that normalises to this key, so a merge stays visible. */
  spellings: string[];
  parcelCount: number;
  totalJustValue: number | null;
  totalAnnualTax: number | null;
  jurisdictions: { value: string; count: number }[];
  mailingLocations: { value: string; count: number }[];
  mailingStreets: string[];
  outOfAreaParcels: number;
  homesteadParcels: number;
  oldestRoofAge: number | null;
  page: number;
  pageSize: number;
  pageCount: number;
  parcels: ParcelSummary[];
}

export function getOwnerProfile(
  store: ParcelStore,
  ownerKey: string,
  page: number,
  pageSize: number,
): OwnerProfile | null {
  const key = normaliseOwnerKey(ownerKey);
  const rows = getOwnerIndex(store).get(key);
  if (rows === undefined || rows.length === 0) return null;

  const spellings = new Map<string, number>();
  const jurisdictions = new Map<string, number>();
  const mailing = new Map<string, number>();
  const streets = new Set<string>();
  let totalJustValue = 0;
  let totalAnnualTax = 0;
  let outOfAreaParcels = 0;
  let homesteadParcels = 0;
  let oldestRoofAge: number | null = null;

  for (const row of rows) {
    const spelling = store.ownerName[row];
    if (spelling !== null && spelling !== undefined) {
      spellings.set(spelling, (spellings.get(spelling) ?? 0) + 1);
    }
    const jurisdiction = store.jurisdiction.values[store.jurisdiction.codes[row] as number];
    if (jurisdiction !== null && jurisdiction !== undefined) {
      jurisdictions.set(jurisdiction, (jurisdictions.get(jurisdiction) ?? 0) + 1);
    }
    const mailingCityStateZip = store.mailingCityStateZip[row];
    if (mailingCityStateZip !== null && mailingCityStateZip !== undefined) {
      mailing.set(mailingCityStateZip, (mailing.get(mailingCityStateZip) ?? 0) + 1);
    }
    const street = store.mailingStreet[row];
    if (street !== null && street !== undefined) streets.add(street);

    const justValue = store.totalJustValue[row] as number;
    if (!Number.isNaN(justValue)) totalJustValue += justValue;
    const annualTax = store.annualTaxTotal[row] as number;
    if (!Number.isNaN(annualTax)) totalAnnualTax += annualTax;

    const flags = store.flags[row] as number;
    if ((flags & FLAG.outOfArea) !== 0) outOfAreaParcels += 1;
    if ((flags & FLAG.homestead) !== 0) homesteadParcels += 1;

    const roofAge = store.roofAge[row] as number;
    if (roofAge !== INT_NULL && (oldestRoofAge === null || roofAge > oldestRoofAge)) {
      oldestRoofAge = roofAge;
    }
  }

  const byCountDescending = (entries: Map<string, number>): { value: string; count: number }[] =>
    [...entries.entries()]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));

  const ordered = Array.from(rows).sort(
    (a, b) => (store.totalJustValue[b] as number) - (store.totalJustValue[a] as number),
  );
  const pageCount = Math.max(1, Math.ceil(ordered.length / pageSize));
  const safePage = Math.min(Math.max(page, 1), pageCount);
  const start = (safePage - 1) * pageSize;

  return {
    key,
    name: byCountDescending(spellings)[0]?.value ?? key,
    spellings: [...spellings.keys()].sort(),
    parcelCount: rows.length,
    totalJustValue: totalJustValue === 0 ? null : totalJustValue,
    totalAnnualTax: totalAnnualTax === 0 ? null : totalAnnualTax,
    jurisdictions: byCountDescending(jurisdictions),
    mailingLocations: byCountDescending(mailing),
    mailingStreets: [...streets].sort().slice(0, 5),
    outOfAreaParcels,
    homesteadParcels,
    oldestRoofAge,
    page: safePage,
    pageSize,
    pageCount,
    parcels: ordered.slice(start, start + pageSize).map((row) => summaryAt(store, row)),
  };
}

export interface OwnerListEntry {
  key: string;
  name: string;
  parcelCount: number;
  totalJustValue: number | null;
  jurisdictionCount: number;
  outOfArea: boolean;
}

/**
 * The largest owner portfolios, which is the entry point for the owner views: a single
 * owner spanning many parcels is exactly the entity a lead-generation user follows.
 */
export function topOwners(store: ParcelStore, limit: number, minParcels: number): OwnerListEntry[] {
  const index = getOwnerIndex(store);
  const entries: OwnerListEntry[] = [];

  for (const [key, rows] of index) {
    if (rows.length < minParcels) continue;
    let totalJustValue = 0;
    const jurisdictions = new Set<number>();
    let outOfArea = 0;
    for (const row of rows) {
      const justValue = store.totalJustValue[row] as number;
      if (!Number.isNaN(justValue)) totalJustValue += justValue;
      jurisdictions.add(store.jurisdiction.codes[row] as number);
      if (((store.flags[row] as number) & FLAG.outOfArea) !== 0) outOfArea += 1;
    }
    entries.push({
      key,
      name: store.ownerName[rows[0] as number] ?? key,
      parcelCount: rows.length,
      totalJustValue: totalJustValue === 0 ? null : totalJustValue,
      jurisdictionCount: jurisdictions.size,
      outOfArea: outOfArea > rows.length / 2,
    });
  }

  return entries
    .sort(
      (a, b) => b.parcelCount - a.parcelCount || (b.totalJustValue ?? 0) - (a.totalJustValue ?? 0),
    )
    .slice(0, limit);
}
