/**
 * Where the published permit tier is announced, and how the parcel pointer learns about it.
 *
 * Two objects, the same convention `publish/current.json` and `publish/ipfs.json` already
 * follow in this bucket: a run-scoped manifest that is never rewritten, and a stable pointer
 * overwritten in one `PutObject` once the manifest is durable. A reader sees the previous
 * generation or this one, never a mixture.
 *
 * Both live under `publish/`, which is the whole point. The CRM's role is read-only and
 * IAM-restricted to that prefix, so an artifact it cannot reach is an artifact that does not
 * exist as far as the product is concerned.
 */
import { GetObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { DATA_PREFIXES, PUBLISH_POINTER_KEY } from '@oracle-seminole/shared';
import type { BbbLookup, MonthCoverage, PublishedPermitStatus } from './permits';

export const PUBLISH_PERMITS_PREFIX = `${DATA_PREFIXES.publish}permits/`;

/** Stable pointer at the permit generation a consumer should read. */
export const PERMITS_POINTER_KEY = `${PUBLISH_PERMITS_PREFIX}current.json`;

export function permitsSnapshotPrefix(runId: string): string {
  return `${PUBLISH_PERMITS_PREFIX}snapshot=${runId}/`;
}

export interface PublishedPermitFile {
  /** File name within the snapshot prefix, e.g. `permits.parquet`. */
  file: string;
  key: string;
  bytes: number;
  rows: number;
}

/**
 * The manifest's own entry carries no size.
 *
 * It cannot: the byte count would have to be inside the object it measures. Naming the key and
 * omitting the number is honest, where a `bytes: 0` would be a measurement that happens to be
 * wrong.
 */
export interface PublishedManifestFile {
  file: string;
  key: string;
}

export interface PermitCounts {
  permitRows: number;
  applications: number;
  /** Distinct parcels carrying at least one permit, whether or not the parcel is published. */
  parcels: number;
  /** …of which join to a parcel in the published snapshot. The number that can be shown. */
  publishedParcels: number;
  roofingPermitRows: number;
  /** Applications whose status detail has been harvested. The rest are `unknown`. */
  applicationsWithStatus: number;
  openPermitRows: number;
  openRoofingPermitRows: number;
  /** Parcels carrying a confirmed-open permit older than three years. The demo population. */
  parcelsWithOpenPermitOverThreeYears: number;
  parcelsWithOpenRoofingPermitOverThreeYears: number;
  contractorNames: number;
  /** Permit rows whose contractor carries a BBB letter grade. */
  rowsWithBbbRating: number;
}

export interface PermitPublicationRecord {
  schema: 'oracle/permits/1';
  version: 1;
  runId: string;
  county: string;
  publishedAt: string;
  /**
   * The instant every `open_years` in this generation is measured against.
   *
   * Stated once, here, rather than left as an implicit "now". Per-row observation times are
   * carried in `open_duration_observed_at`; this is the newest of them, and the date a
   * consumer should quote when it reports how long a permit has been open.
   */
  referenceDate: string;
  /** The parcel snapshot these permits were joined against. */
  parcelSnapshot: { runId: string; parcelCount: number };
  prefix: string;
  files: {
    manifest: PublishedManifestFile;
    permits: PublishedPermitFile;
    parcelIndex: PublishedPermitFile;
    contractors: PublishedPermitFile;
  };
  totals: { bytes: number; objects: number };
  coverage: {
    census: MonthCoverage & {
      complete: false;
      /** What the window does and does not license a consumer to claim. */
      note: string;
    };
    status: {
      applicationsWithStatus: number;
      applicationsTotal: number;
      fraction: number;
      runsReduced: number;
      note: string;
    };
    bbb: {
      runId: string;
      contractorsSearched: number;
      contractorsMatched: number;
      contractorsRated: number;
      note: string;
    };
    /** Why a parcel may be missing, in one sentence a consumer can quote verbatim. */
    absenceMeaning: string;
  };
  counts: PermitCounts;
  /** Enumerations a consumer must not have to guess at. */
  vocabulary: {
    status: readonly PublishedPermitStatus[];
    bbbLookup: readonly BbbLookup[];
  };
  usage: { duckdb: string };
}

/**
 * The block merged into `publish/current.json`.
 *
 * Small on purpose. It answers "are permits available, and where are they" and then defers to
 * the permit manifest for everything else, so the parcel pointer does not become a second,
 * staler copy of the permit tier's coverage story.
 */
export interface PermitPointerBlock {
  available: true;
  schema: 'oracle/permits/1';
  runId: string;
  pointerKey: string;
  prefix: string;
  manifestKey: string;
  permitsKey: string;
  parcelIndexKey: string;
  contractorsKey: string;
  referenceDate: string;
  publishedAt: string;
  permitRows: number;
  parcelsWithPermits: number;
  coverage: {
    firstMonth: string | null;
    lastMonth: string | null;
    months: number;
    complete: false;
    statusKnownApplications: number;
  };
}

export function permitPointerBlock(record: PermitPublicationRecord): PermitPointerBlock {
  return {
    available: true,
    schema: record.schema,
    runId: record.runId,
    pointerKey: PERMITS_POINTER_KEY,
    prefix: record.prefix,
    manifestKey: record.files.manifest.key,
    permitsKey: record.files.permits.key,
    parcelIndexKey: record.files.parcelIndex.key,
    contractorsKey: record.files.contractors.key,
    referenceDate: record.referenceDate,
    publishedAt: record.publishedAt,
    permitRows: record.counts.permitRows,
    parcelsWithPermits: record.counts.publishedParcels,
    coverage: {
      firstMonth: record.coverage.census.firstMonth,
      lastMonth: record.coverage.census.lastMonth,
      months: record.coverage.census.months,
      complete: false,
      statusKnownApplications: record.counts.applicationsWithStatus,
    },
  };
}

/**
 * Add the permit block to the parcel pointer without touching anything else in it.
 *
 * A spread of the parsed object rather than a rewrite from a schema. `publish/current.json` is
 * produced by the snapshot publish step, which this tier does not own, and a publisher that
 * reconstructed the pointer from its own idea of the shape would drop any field that step adds
 * later. Every existing key survives byte-for-byte; only `permits` is introduced or replaced.
 *
 * This is additive, and it is also fragile in one specific way that is documented rather than
 * hidden: the snapshot publish step writes `publish/current.json` whole, so the next parcel
 * publish drops this block until the permit publish is re-run. See
 * `docs/permit-publication.md` for the one-line change in that step which would make it
 * durable, and why this tier does not make it.
 */
export function mergePermitPointer(
  pointer: Record<string, unknown>,
  block: PermitPointerBlock,
): Record<string, unknown> {
  return { ...pointer, permits: block };
}

async function readJson(s3: S3Client, bucket: string, key: string): Promise<unknown> {
  const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const body = await response.Body?.transformToString();
  if (!body) throw new Error(`${key} is empty`);
  return JSON.parse(body);
}

async function putJson(s3: S3Client, bucket: string, key: string, value: unknown): Promise<number> {
  const body = `${JSON.stringify(value, null, 2)}\n`;
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      ContentType: 'application/json',
      Body: body,
    }),
  );
  return Buffer.byteLength(body);
}

/**
 * Announce the generation: run-scoped manifest, then stable permit pointer, then the parcel
 * pointer. Never the other way round — each step only runs once the thing it points at is
 * durable, so a crash leaves an unreferenced artifact rather than a pointer aimed at nothing.
 */
export async function announcePermits(
  s3: S3Client,
  bucket: string,
  record: PermitPublicationRecord,
): Promise<{ manifestKey: string; pointerKey: string; parcelPointerKey: string }> {
  await putJson(s3, bucket, record.files.manifest.key, record);
  await putJson(s3, bucket, PERMITS_POINTER_KEY, record);

  const pointer = (await readJson(s3, bucket, PUBLISH_POINTER_KEY)) as Record<string, unknown>;
  await putJson(
    s3,
    bucket,
    PUBLISH_POINTER_KEY,
    mergePermitPointer(pointer, permitPointerBlock(record)),
  );

  return {
    manifestKey: record.files.manifest.key,
    pointerKey: PERMITS_POINTER_KEY,
    parcelPointerKey: PUBLISH_POINTER_KEY,
  };
}
