import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { parquetMetadata, parquetReadObjects } from 'hyparquet';
import { compressors } from 'hyparquet-compressors';
import { z } from 'zod';
import { PERMITS_POINTER_KEY } from '../publish/permit-pointer';
import { logger } from '../observability';

/**
 * The published permit snapshot, held for the life of a warm container.
 *
 * Two objects, two jobs. `parcel-index.parquet` is one row per parcel and is what makes
 * "open roofing, longest first" a filter rather than a fold over half a million rows.
 * `permits.parquet` is read only for confirmed-open roofing lines — contractor, BBB, and
 * years-open for the results list and the parcel detail. Everything else stays on disk.
 *
 * **`unknown` is not open.** Status comes from the publisher's four-value lifecycle
 * (`open` / `closed` / `void` / `unknown`). `unknown` means the status detail has not
 * been harvested. Treating it as closed would invent closures; treating it as open would
 * invent stalled jobs. Neither is a fact.
 *
 * **Roofing is the publisher's `roofing_relevant` flag.** That is the county application-type
 * classification written into the artifact. This serving tier does not re-classify.
 *
 * The permit objects are ZSTD. The parcel snapshot is Snappy. `hyparquet` needs its
 * compressor companion here or the read fails with `unsupported compression codec: ZSTD`.
 */

const BUCKET = process.env.DATA_BUCKET_NAME ?? '';
const POINTER_TTL_MS = 10 * 60 * 1000;
const PARSE_CHUNK_ROWS = 32_000;

const s3 = new S3Client({});

const POINTER = z.object({
  runId: z.string().min(1),
  county: z.string().min(1),
  publishedAt: z.string().min(1),
  referenceDate: z.string().min(1).optional(),
  files: z.object({
    permits: z.object({ key: z.string().min(1), rows: z.number().int().nonnegative() }),
    parcelIndex: z.object({ key: z.string().min(1), rows: z.number().int().nonnegative() }),
  }),
  coverage: z
    .object({
      census: z
        .object({
          firstMonth: z.string().optional(),
          lastMonth: z.string().optional(),
          note: z.string().optional(),
        })
        .optional(),
      status: z
        .object({
          applicationsWithStatus: z.number().int().nonnegative().optional(),
          applicationsTotal: z.number().int().nonnegative().optional(),
          fraction: z.number().optional(),
          note: z.string().optional(),
        })
        .optional(),
      bbb: z
        .object({
          contractorsRated: z.number().int().nonnegative().optional(),
          note: z.string().optional(),
        })
        .optional(),
      absenceMeaning: z.string().optional(),
    })
    .optional(),
  counts: z
    .object({
      permitRows: z.number().int().nonnegative().optional(),
      applicationsWithStatus: z.number().int().nonnegative().optional(),
      openRoofingPermitRows: z.number().int().nonnegative().optional(),
    })
    .optional(),
});

export type PermitPointer = z.infer<typeof POINTER>;

const INDEX_COLUMNS = [
  'parcel_id',
  'permit_count',
  'application_count',
  'open_permit_count',
  'open_roofing_permit_count',
  'unknown_status_permit_count',
  'max_open_years',
  'max_open_roofing_years',
] as const;

const PERMIT_COLUMNS = [
  'parcel_id',
  'application_no',
  'permit_type',
  'description',
  'issued_on',
  'status',
  'roofing_relevant',
  'contractor_name',
  'open_years',
  'open_duration_observed_at',
  'bbb_lookup',
  'bbb_rating',
  'bbb_rating_score',
] as const;

export type BbbLookup = 'rated' | 'matched_unrated' | 'searched_no_match' | 'not_searched';

export interface ParcelPermitIndex {
  permitCount: number;
  applicationCount: number;
  openPermitCount: number;
  openRoofingCount: number;
  unknownStatusCount: number;
  maxOpenYears: number | null;
  maxOpenRoofingYears: number | null;
}

export interface OpenRoofingPermit {
  parcelId: string;
  applicationNo: string | null;
  permitType: string | null;
  description: string | null;
  issuedOn: string | null;
  contractorName: string | null;
  openYears: number | null;
  observedAt: string | null;
  bbbLookup: BbbLookup;
  bbbRating: string | null;
  bbbScore: number | null;
}

export interface OpenRoofingCard {
  count: number;
  maxOpenYears: number | null;
  contractorName: string | null;
  bbbLookup: BbbLookup;
  bbbRating: string | null;
  applicationNo: string | null;
  permitType: string | null;
}

export interface PermitCoverage {
  runId: string;
  publishedAt: string;
  referenceDate: string | null;
  statusNote: string;
  censusNote: string | null;
  absenceMeaning: string | null;
  applicationsWithStatus: number | null;
  applicationsTotal: number | null;
}

export interface PermitLookup {
  pointer: PermitPointer;
  coverage: PermitCoverage;
  /** Parcels that carry at least one confirmed-open roofing permit, years-open for sort. */
  openRoofingYearsByParcel: Map<string, number>;
  index: Map<string, ParcelPermitIndex>;
  openRoofing: Map<string, OpenRoofingPermit[]>;
  loadMs: number;
}

export interface ParcelPermits {
  available: true;
  coverage: PermitCoverage;
  summary: ParcelPermitIndex | null;
  openRoofing: OpenRoofingPermit[];
}

const DEFAULT_STATUS_NOTE =
  'Lifecycle is harvested for a fraction of applications. Status "unknown" means unharvested, not closed.';

export function toText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

export function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'bigint') return Number(value);
  return null;
}

export function toIsoDate(value: unknown): string | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  if (typeof value === 'string' && value !== '') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? value.slice(0, 10) : parsed.toISOString().slice(0, 10);
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Parquet DATE is days since epoch.
    if (value > 0 && value < 100_000) {
      return new Date(value * 86_400_000).toISOString().slice(0, 10);
    }
    return new Date(value).toISOString().slice(0, 10);
  }
  return null;
}

export function isTrue(value: unknown): boolean {
  return value === true || value === 1 || value === 'true';
}

/** Publisher lifecycle. `unknown` is unharvested and must not be treated as open. */
export function isConfirmedOpen(status: unknown): boolean {
  return toText(status) === 'open';
}

export function isOpenRoofingRow(status: unknown, roofingRelevant: unknown): boolean {
  return isConfirmedOpen(status) && isTrue(roofingRelevant);
}

export function asBbbLookup(value: unknown): BbbLookup {
  const text = toText(value);
  if (
    text === 'rated' ||
    text === 'matched_unrated' ||
    text === 'searched_no_match' ||
    text === 'not_searched'
  ) {
    return text;
  }
  return 'not_searched';
}

export function matchesOpenRoofingFilter(
  years: number | undefined,
  minOpenYears: number | undefined,
): boolean {
  if (years === undefined) return false;
  if (minOpenYears !== undefined && years < minOpenYears) return false;
  return true;
}

export function pickLongestOpen(permits: readonly OpenRoofingPermit[]): OpenRoofingPermit | null {
  let best: OpenRoofingPermit | null = null;
  let bestYears = Number.NEGATIVE_INFINITY;
  for (const permit of permits) {
    const years = permit.openYears ?? Number.NEGATIVE_INFINITY;
    if (years > bestYears) {
      best = permit;
      bestYears = years;
    }
  }
  return best;
}

export function cardFromPermits(permits: readonly OpenRoofingPermit[]): OpenRoofingCard | null {
  if (permits.length === 0) return null;
  const longest = pickLongestOpen(permits);
  if (longest === null) return null;
  return {
    count: permits.length,
    maxOpenYears: longest.openYears,
    contractorName: longest.contractorName,
    bbbLookup: longest.bbbLookup,
    bbbRating: longest.bbbRating,
    applicationNo: longest.applicationNo,
    permitType: longest.permitType,
  };
}

function intOrZero(value: unknown): number {
  const parsed = toNumber(value);
  return parsed === null ? 0 : Math.trunc(parsed);
}

export function parseIndexRecord(record: Record<string, unknown>): {
  parcelId: string;
  row: ParcelPermitIndex;
} | null {
  const parcelId = toText(record.parcel_id);
  if (parcelId === null) return null;
  return {
    parcelId,
    row: {
      permitCount: intOrZero(record.permit_count),
      applicationCount: intOrZero(record.application_count),
      openPermitCount: intOrZero(record.open_permit_count),
      openRoofingCount: intOrZero(record.open_roofing_permit_count),
      unknownStatusCount: intOrZero(record.unknown_status_permit_count),
      maxOpenYears: toNumber(record.max_open_years),
      maxOpenRoofingYears: toNumber(record.max_open_roofing_years),
    },
  };
}

export function parseOpenRoofingRecord(record: Record<string, unknown>): OpenRoofingPermit | null {
  if (!isOpenRoofingRow(record.status, record.roofing_relevant)) return null;
  const parcelId = toText(record.parcel_id);
  if (parcelId === null) return null;
  return {
    parcelId,
    applicationNo: toText(record.application_no),
    permitType: toText(record.permit_type),
    description: toText(record.description),
    issuedOn: toIsoDate(record.issued_on),
    contractorName: toText(record.contractor_name),
    openYears: toNumber(record.open_years),
    observedAt: toText(record.open_duration_observed_at),
    bbbLookup: asBbbLookup(record.bbb_lookup),
    bbbRating: toText(record.bbb_rating),
    bbbScore: toNumber(record.bbb_rating_score),
  };
}

export function buildYearsByParcel(index: Map<string, ParcelPermitIndex>): Map<string, number> {
  const years = new Map<string, number>();
  for (const [parcelId, row] of index) {
    if (row.openRoofingCount <= 0) continue;
    years.set(parcelId, row.maxOpenRoofingYears ?? 0);
  }
  return years;
}

function coverageFrom(pointer: PermitPointer): PermitCoverage {
  return {
    runId: pointer.runId,
    publishedAt: pointer.publishedAt,
    referenceDate: pointer.referenceDate ?? null,
    statusNote: pointer.coverage?.status?.note ?? DEFAULT_STATUS_NOTE,
    censusNote: pointer.coverage?.census?.note ?? null,
    absenceMeaning: pointer.coverage?.absenceMeaning ?? null,
    applicationsWithStatus: pointer.coverage?.status?.applicationsWithStatus ?? null,
    applicationsTotal: pointer.coverage?.status?.applicationsTotal ?? null,
  };
}

async function getBytes(key: string): Promise<Uint8Array> {
  const response = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  const bytes = await response.Body?.transformToByteArray();
  if (!bytes) throw new Error(`s3://${BUCKET}/${key} returned no body`);
  return bytes;
}

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

let cached: { lookup: PermitLookup; loadedAt: number } | null = null;
let inflight: Promise<PermitLookup> | null = null;

export async function getPermitLookup(): Promise<PermitLookup> {
  if (cached !== null && Date.now() - cached.loadedAt < POINTER_TTL_MS) {
    return cached.lookup;
  }
  if (inflight !== null) return inflight;
  inflight = loadPermitLookup()
    .then((lookup) => {
      cached = { lookup, loadedAt: Date.now() };
      return lookup;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export async function loadPermitLookup(): Promise<PermitLookup> {
  const startedAt = Date.now();
  const pointerBytes = await getBytes(PERMITS_POINTER_KEY);
  const pointer = POINTER.parse(JSON.parse(new TextDecoder().decode(pointerBytes)));

  const indexBytes = await getBytes(pointer.files.parcelIndex.key);
  const indexRows = (await parquetReadObjects({
    file: asArrayBuffer(indexBytes),
    compressors,
    columns: [...INDEX_COLUMNS],
  })) as Record<string, unknown>[];

  const index = new Map<string, ParcelPermitIndex>();
  for (const record of indexRows) {
    const parsed = parseIndexRecord(record);
    if (parsed === null) continue;
    index.set(parsed.parcelId, parsed.row);
  }

  const permitBytes = await getBytes(pointer.files.permits.key);
  const file = asArrayBuffer(permitBytes);
  const total = Number(parquetMetadata(file).num_rows);
  const openRoofing = new Map<string, OpenRoofingPermit[]>();

  for (let start = 0; start < total; start += PARSE_CHUNK_ROWS) {
    const chunk = (await parquetReadObjects({
      file,
      compressors,
      columns: [...PERMIT_COLUMNS],
      rowStart: start,
      rowEnd: Math.min(start + PARSE_CHUNK_ROWS, total),
    })) as Record<string, unknown>[];
    for (const record of chunk) {
      const permit = parseOpenRoofingRecord(record);
      if (permit === null) continue;
      const existing = openRoofing.get(permit.parcelId);
      if (existing === undefined) openRoofing.set(permit.parcelId, [permit]);
      else existing.push(permit);
    }
  }

  const lookup: PermitLookup = {
    pointer,
    coverage: coverageFrom(pointer),
    openRoofingYearsByParcel: buildYearsByParcel(index),
    index,
    openRoofing,
    loadMs: Date.now() - startedAt,
  };

  logger.info('permit lookup loaded', {
    runId: pointer.runId,
    indexRows: index.size,
    openRoofingParcels: openRoofing.size,
    loadMs: lookup.loadMs,
  });

  return lookup;
}

export function openRoofingCard(lookup: PermitLookup, parcelId: string): OpenRoofingCard | null {
  return cardFromPermits(lookup.openRoofing.get(parcelId) ?? []);
}

export function parcelPermits(lookup: PermitLookup, parcelId: string): ParcelPermits {
  return {
    available: true,
    coverage: lookup.coverage,
    summary: lookup.index.get(parcelId) ?? null,
    openRoofing: lookup.openRoofing.get(parcelId) ?? [],
  };
}
