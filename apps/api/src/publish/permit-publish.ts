/**
 * Builds and publishes the permit tier into `publish/`.
 *
 * The shape is three Parquet files and a manifest, mirroring the parcel tier's own choices for
 * the same reasons: the consumer is a Lambda that reads whole objects over HTTPS, has no
 * directory listing, and pays for every megabyte in heap.
 *
 * - `permits.parquet` — one row per permit row, the full census union. 388,289 rows in 6.1 MB.
 * - `parcel-index.parquet` — one row per published parcel that has a permit, pre-aggregated.
 *   This is what a filter reads: a permit-status or years-open search resolves against 71,077
 *   short rows instead of scanning the permit table, and the answer is already correct.
 * - `contractors.parquet` — one row per contractor, carrying the BBB join.
 *
 * The aggregate table is not a cache of the permit table, it is what makes the permit table
 * affordable to have at all. Without it a consumer would have to hold all 388,289 rows in heap
 * to answer "does this parcel have an open permit", which is the question every row of a
 * county-wide search asks.
 *
 * ZSTD rather than Snappy, and sorted with explicit row groups, for the same reasons the parcel
 * query table is: the file is fetched whole over the network by something with a memory budget.
 *
 * Idempotency is on content. The run id is a fingerprint of every input object's ETag, so
 * re-running against an unchanged bucket produces the same run id and the publish declines to
 * spend anything. That matters because the census sweep is still running: this step is expected
 * to be re-run repeatedly, and most re-runs early in a sweep will find nothing new.
 */
import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type _Object,
} from '@aws-sdk/client-s3';
import { AWS_REGION, COUNTY, PUBLISH_POINTER_KEY } from '@oracle-seminole/shared';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { queryRow, runSql } from './duckdb';
import {
  announcePermits,
  permitsSnapshotPrefix,
  PERMITS_POINTER_KEY,
  type PermitCounts,
  type PermitPublicationRecord,
  type PublishedPermitFile,
} from './permit-pointer';
import {
  absenceMeaning,
  analyseMonthCoverage,
  APPLICATION_TYPE_CODE_SQL,
  bbbLookupFor,
  BBB_LOOKUPS,
  CENSUS_PARCEL_ID_SQL,
  PERMIT_TYPE_CODE_SQL,
  openYears,
  publishedStatus,
  PERMIT_STATUSES,
  reduceToCurrentObservation,
  WELL_FORMED_PARCEL_ID_SQL,
  type MonthCoverage,
  type StatusObservation,
} from './permits';

const CENSUS_PREFIX = 'staged/permits/census/';
const STATUS_PREFIX = 'staged/permits/status/';
const BBB_POINTER_KEY = 'staged/bbb/contractor-ratings/current.json';

/** Parallel GETs. The census month objects average ~1 MB, so ten in flight saturates the link. */
const FETCH_CONCURRENCY = 10;

class PermitPublishError extends Error {
  override readonly name = 'PermitPublishError';
}

export interface PublishPermitsOptions {
  /** Scratch directory for the mirrored inputs and built Parquet. */
  workDir: string;
  /** Publish even when the input fingerprint matches the published generation. */
  force?: boolean;
  onProgress?: (message: string) => void;
}

interface ParcelPointer {
  runId: string;
  county: string;
  snapshotPrefix: string;
  parcelCount: number;
}

interface BbbPointer {
  runId: string;
  matchesKey: string;
  businessCount: number;
  matchedContractorCount: number;
}

interface MirroredObject {
  key: string;
  path: string;
  etag: string;
  size: number;
  lastModified: string;
}

export interface PermitPublishPlan {
  s3: S3Client;
  runId: string;
  record: PermitPublicationRecord;
  /** Local paths of the built artifacts, in the order they upload. */
  built: { file: string; path: string; key: string; bytes: number; rows: number }[];
  published: PermitPublicationRecord | null;
  unchanged: boolean;
}

/* ------------------------------------------------------------------ S3 helpers */

async function listAll(s3: S3Client, bucket: string, prefix: string): Promise<_Object[]> {
  const objects: _Object[] = [];
  let token: string | undefined;

  do {
    const page = await s3.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }),
    );
    objects.push(...(page.Contents ?? []));
    token = page.NextContinuationToken;
  } while (token);

  return objects;
}

async function getJson<T>(s3: S3Client, bucket: string, key: string): Promise<T> {
  const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const body = await response.Body?.transformToString();
  if (!body) throw new PermitPublishError(`${key} is empty`);
  return JSON.parse(body) as T;
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await worker(items[index] as T);
      }
    }),
  );
  return results;
}

/**
 * Mirror a prefix locally, skipping objects already present at the right size.
 *
 * The census union is 289 MB across 294 objects today and grows with every month the sweep
 * lands. Re-running the publish after a partial failure, or an hour later to pick up new
 * months, must not re-pull all of it.
 */
async function mirror(
  s3: S3Client,
  bucket: string,
  objects: readonly _Object[],
  targetDir: string,
  strip: string,
): Promise<{ mirrored: MirroredObject[]; fetched: number; bytes: number }> {
  let fetched = 0;

  const mirrored = await mapWithConcurrency(objects, FETCH_CONCURRENCY, async (object) => {
    const key = object.Key as string;
    const path = join(targetDir, key.slice(strip.length));

    if (!existsSync(path) || statSync(path).size !== object.Size) {
      mkdirSync(dirname(path), { recursive: true });
      const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      await pipeline(response.Body as Readable, createWriteStream(path));
      fetched += 1;
    }

    return {
      key,
      path,
      etag: (object.ETag ?? '').replaceAll('"', ''),
      size: object.Size ?? 0,
      lastModified: (object.LastModified ?? new Date(0)).toISOString(),
    };
  });

  return {
    mirrored,
    fetched,
    bytes: objects.reduce((total, object) => total + (object.Size ?? 0), 0),
  };
}

/* ------------------------------------------------------------------ input preparation */

/**
 * The census objects that are the dataset of record.
 *
 * Only the keys with no `run=` segment. The permits tier writes both: a run-scoped sample of
 * each month, and the accumulated union of every sweep of it. Source A's pager is stateful and
 * one sweep is a sample rather than the whole month, so reading the run-scoped keys would
 * publish whichever sample happened to be newest and would make the row count oscillate
 * between publishes.
 */
function censusUnionObjects(objects: readonly _Object[]): _Object[] {
  return objects.filter((object) => {
    const key = object.Key ?? '';
    return key.endsWith('/rows.ndjson') && !key.includes('/run=');
  });
}

function monthOf(key: string): string | null {
  return /month=(\d{4}-\d{2})\//.exec(key)?.[1] ?? null;
}

/**
 * Flatten the status observations into the one row per application the join needs.
 *
 * Done here rather than in SQL because the derivations are decisions, not arithmetic — which
 * observation of an application is current, whether its open duration is trustworthy, what
 * "years open" means — and those belong in a module a test can reach. See `./permits`.
 *
 * The observation instant comes from the S3 object's `LastModified`. The staged records carry
 * no timestamp of their own, and inventing one from the harvest run id would order the runs
 * lexicographically, which measured backwards against this bucket.
 */
async function flattenStatus(
  mirrored: readonly MirroredObject[],
  outPath: string,
): Promise<{ rows: number; applications: number; runs: number; referenceDate: string | null }> {
  const observations: StatusObservation[] = [];
  const runs = new Set<string>();

  for (const object of mirrored) {
    const text = await readFile(object.path, 'utf8');
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      const record = JSON.parse(line) as Omit<StatusObservation, 'observedAt'>;
      observations.push({ ...record, observedAt: object.lastModified });
      runs.add(record.runId);
    }
  }

  const current = reduceToCurrentObservation(observations);
  const lines = current.map((observation) => {
    const { status, durationTrusted } = publishedStatus(observation);
    const days = durationTrusted ? observation.openDurationDays : null;
    return JSON.stringify({
      application_no: observation.appNo,
      status,
      status_raw: observation.rawStatus,
      status_canonical: observation.canonicalStatus,
      open_duration_days: days,
      open_years: days === null ? null : openYears(days),
      open_duration_observed_at: observation.observedAt,
      closed_on: observation.closedDate,
      status_run_id: observation.runId,
      status_contractor: observation.generalContractor,
      status_tenant: observation.tenantName,
      status_application_type: observation.applicationType,
    });
  });

  await writeFile(outPath, lines.length === 0 ? '' : `${lines.join('\n')}\n`);

  return {
    rows: observations.length,
    applications: current.length,
    runs: runs.size,
    referenceDate: current.reduce<string | null>(
      (newest, observation) =>
        newest === null || observation.observedAt > newest ? observation.observedAt : newest,
      null,
    ),
  };
}

/**
 * Flatten the BBB contractor matches, resolving each into an explicit lookup state.
 *
 * `matchesKey` is read from `current.json` rather than globbed off the prefix. The prefix holds
 * every run ever made, including smaller superseded ones, and the newest key by name is not the
 * newest run.
 */
async function flattenContractors(
  path: string,
  outPath: string,
): Promise<{ searched: number; matched: number; rated: number }> {
  interface BbbMatch {
    permitContractorName: string;
    matched: boolean;
    rating: string | null;
    ratingScore: number | null;
    bbbBusinessName: string | null;
    accredited: boolean | null;
    confidence: number | null;
    matchTier: string | null;
    city: string | null;
    profileUrl: string | null;
    phones?: string[];
  }

  const matches: BbbMatch[] = (await readFile(path, 'utf8'))
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as BbbMatch)
    .sort((left, right) => (left.permitContractorName < right.permitContractorName ? -1 : 1));

  const lines = matches.map((match) =>
    JSON.stringify({
      contractor_name: match.permitContractorName,
      bbb_lookup: bbbLookupFor(match),
      bbb_rating: match.rating,
      bbb_rating_score: match.ratingScore,
      bbb_business_name: match.bbbBusinessName,
      bbb_accredited: match.accredited,
      bbb_confidence: match.confidence,
      bbb_match_tier: match.matchTier,
      bbb_city: match.city,
      bbb_profile_url: match.profileUrl,
      bbb_phone: match.phones?.[0] ?? null,
    }),
  );

  await writeFile(outPath, lines.length === 0 ? '' : `${lines.join('\n')}\n`);

  return {
    searched: matches.length,
    matched: matches.filter((match) => match.matched).length,
    rated: matches.filter((match) => match.rating !== null).length,
  };
}

/* ------------------------------------------------------------------ the build */

function sqlPath(path: string): string {
  return path.replaceAll("'", "''");
}

interface BuildStats {
  permitRows: number;
  applications: number;
  parcels: number;
  publishedParcels: number;
  roofingPermitRows: number;
  malformedParcelIds: number;
  openPermitRows: number;
  openRoofingPermitRows: number;
  parcelsWithOpenPermitOverThreeYears: number;
  parcelsWithOpenRoofingPermitOverThreeYears: number;
  parcelIndexRows: number;
  contractorRows: number;
  contractorsRated: number;
  rowsWithBbbRating: number;
}

/**
 * One DuckDB script for all three artifacts.
 *
 * Single-threaded with a total ordering on every `COPY`, so the same inputs produce
 * byte-identical Parquet. That is what lets the fingerprint-based skip mean anything: without
 * it, "unchanged" could not be distinguished from "rewritten identically".
 */
function buildArtifacts(
  snapshotDir: string,
  censusDir: string,
  statusPath: string,
  contractorsPath: string,
  outDir: string,
): BuildStats {
  const parcelIdExpression = CENSUS_PARCEL_ID_SQL('c.parcelId');
  const wellFormed = WELL_FORMED_PARCEL_ID_SQL('c.parcelId');

  runSql(
    `CREATE VIEW parcels AS
       SELECT DISTINCT parcel_id, geohash5
       FROM read_parquet('${sqlPath(join(snapshotDir, '**', '*.parquet'))}', hive_partitioning = true);
     CREATE VIEW census AS
       SELECT * FROM read_json_auto('${sqlPath(join(censusDir, '**', '*.ndjson'))}',
                                    format = 'newline_delimited', union_by_name = true);
     CREATE VIEW status AS
       SELECT * FROM read_json_auto('${sqlPath(statusPath)}', format = 'newline_delimited');
     CREATE VIEW bbb AS
       SELECT * FROM read_json_auto('${sqlPath(contractorsPath)}', format = 'newline_delimited');

     CREATE TABLE permits AS
     SELECT
       CASE WHEN ${wellFormed} THEN ${parcelIdExpression} END        AS parcel_id,
       ${wellFormed}
         AND ${parcelIdExpression} IN (SELECT parcel_id FROM parcels) AS parcel_published,
       c.rowKey                                                       AS permit_id,
       c.appNo                                                        AS application_no,
       c.structureSequence                                            AS structure_sequence,
       c.permitTypeSequence                                           AS permit_type_sequence,
       try_cast(c.issuedOn AS DATE)                                   AS issued_on,
       c.permitType                                                   AS permit_type,
       ${PERMIT_TYPE_CODE_SQL('c.permitType')}                        AS permit_type_code,
       c.description                                                  AS description,
       ${APPLICATION_TYPE_CODE_SQL('c.description')}                  AS application_type_code,
       coalesce(c.roofingRelevant, false)                             AS roofing_relevant,
       c.contractorName                                               AS contractor_name,
       try_cast(c.valuationUsd AS BIGINT)                             AS valuation_usd,
       coalesce(status.status, 'unknown')                             AS status,
       status.status_raw                                              AS status_raw,
       status.status_canonical                                        AS status_canonical,
       status.open_duration_days::INTEGER                             AS open_duration_days,
       status.open_years::DOUBLE                                      AS open_years,
       status.open_duration_observed_at                               AS open_duration_observed_at,
       try_cast(status.closed_on AS DATE)                             AS closed_on,
       status.status_contractor                                       AS status_contractor,
       coalesce(bbb.bbb_lookup, 'not_searched')                       AS bbb_lookup,
       bbb.bbb_rating                                                 AS bbb_rating,
       bbb.bbb_rating_score::INTEGER                                  AS bbb_rating_score,
       bbb.bbb_accredited                                             AS bbb_accredited,
       bbb.bbb_business_name                                          AS bbb_business_name,
       bbb.bbb_confidence::DOUBLE                                     AS bbb_confidence
     FROM census c
     LEFT JOIN status ON status.application_no = c.appNo
     LEFT JOIN bbb ON bbb.contractor_name = c.contractorName;

     COPY (SELECT * FROM permits ORDER BY parcel_id NULLS LAST, issued_on NULLS LAST, permit_id)
       TO '${sqlPath(join(outDir, 'permits.parquet'))}'
       (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 40000);

     CREATE TABLE parcel_index AS
     SELECT
       p.parcel_id,
       p.geohash5,
       count(*)::INTEGER                                                       AS permit_count,
       -- One application spans several permit rows, one per trade. Both grains are published so
       -- a consumer can list trade lines without reporting a parcel's permit count three times.
       count(DISTINCT permits.application_no)::INTEGER                         AS application_count,
       sum(CASE WHEN permits.roofing_relevant THEN 1 ELSE 0 END)::INTEGER      AS roofing_permit_count,
       min(permits.issued_on)                                                  AS first_permit_on,
       max(permits.issued_on)                                                  AS last_permit_on,
       sum(CASE WHEN permits.status = 'open' THEN 1 ELSE 0 END)::INTEGER        AS open_permit_count,
       sum(CASE WHEN permits.status = 'open' AND permits.roofing_relevant
                THEN 1 ELSE 0 END)::INTEGER                                    AS open_roofing_permit_count,
       count(DISTINCT CASE WHEN permits.status = 'open' AND permits.roofing_relevant
                           THEN permits.application_no END)::INTEGER            AS open_roofing_application_count,
       sum(CASE WHEN permits.status = 'closed' THEN 1 ELSE 0 END)::INTEGER      AS closed_permit_count,
       sum(CASE WHEN permits.status = 'unknown' THEN 1 ELSE 0 END)::INTEGER     AS unknown_status_permit_count,
       max(permits.open_years)                                                 AS max_open_years,
       max(CASE WHEN permits.roofing_relevant THEN permits.open_years END)     AS max_open_roofing_years
     FROM permits JOIN parcels p ON p.parcel_id = permits.parcel_id
     GROUP BY p.parcel_id, p.geohash5;

     COPY (SELECT * FROM parcel_index ORDER BY geohash5, parcel_id)
       TO '${sqlPath(join(outDir, 'parcel-index.parquet'))}'
       (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 20000);

     CREATE TABLE contractors AS
     SELECT
       permits.contractor_name,
       count(*)::INTEGER                                                    AS permit_count,
       sum(CASE WHEN permits.roofing_relevant THEN 1 ELSE 0 END)::INTEGER   AS roofing_permit_count,
       min(permits.issued_on)                                               AS first_permit_on,
       max(permits.issued_on)                                               AS last_permit_on,
       coalesce(any_value(bbb.bbb_lookup), 'not_searched')                  AS bbb_lookup,
       any_value(bbb.bbb_rating)                                            AS bbb_rating,
       any_value(bbb.bbb_rating_score)::INTEGER                             AS bbb_rating_score,
       any_value(bbb.bbb_business_name)                                     AS bbb_business_name,
       any_value(bbb.bbb_accredited)                                        AS bbb_accredited,
       any_value(bbb.bbb_confidence)::DOUBLE                                AS bbb_confidence,
       any_value(bbb.bbb_match_tier)                                        AS bbb_match_tier,
       any_value(bbb.bbb_city)                                              AS bbb_city,
       any_value(bbb.bbb_profile_url)                                       AS bbb_profile_url,
       any_value(bbb.bbb_phone)                                             AS bbb_phone
     FROM permits LEFT JOIN bbb ON bbb.contractor_name = permits.contractor_name
     WHERE permits.contractor_name IS NOT NULL
     GROUP BY permits.contractor_name;

     COPY (SELECT * FROM contractors ORDER BY contractor_name)
       TO '${sqlPath(join(outDir, 'contractors.parquet'))}'
       (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 20000);`,
  );

  return queryRow<BuildStats>(
    `CREATE VIEW pm AS SELECT * FROM read_parquet('${sqlPath(join(outDir, 'permits.parquet'))}');
     CREATE VIEW pidx AS SELECT * FROM read_parquet('${sqlPath(join(outDir, 'parcel-index.parquet'))}');
     CREATE VIEW ctr AS SELECT * FROM read_parquet('${sqlPath(join(outDir, 'contractors.parquet'))}');
     SELECT
       (SELECT count(*) FROM pm)::BIGINT                                              AS "permitRows",
       (SELECT count(DISTINCT application_no) FROM pm)::BIGINT                        AS applications,
       (SELECT count(DISTINCT parcel_id) FROM pm)::BIGINT                             AS parcels,
       (SELECT count(*) FROM pidx)::BIGINT                                            AS "publishedParcels",
       (SELECT count_if(roofing_relevant) FROM pm)::BIGINT                            AS "roofingPermitRows",
       (SELECT count_if(parcel_id IS NULL) FROM pm)::BIGINT                           AS "malformedParcelIds",
       (SELECT count_if(status = 'open') FROM pm)::BIGINT                             AS "openPermitRows",
       (SELECT count_if(status = 'open' AND roofing_relevant) FROM pm)::BIGINT         AS "openRoofingPermitRows",
       (SELECT count_if(max_open_years >= 3) FROM pidx)::BIGINT                       AS "parcelsWithOpenPermitOverThreeYears",
       (SELECT count_if(max_open_roofing_years >= 3) FROM pidx)::BIGINT               AS "parcelsWithOpenRoofingPermitOverThreeYears",
       (SELECT count(*) FROM pidx)::BIGINT                                            AS "parcelIndexRows",
       (SELECT count(*) FROM ctr)::BIGINT                                             AS "contractorRows",
       (SELECT count_if(bbb_rating IS NOT NULL) FROM ctr)::BIGINT                     AS "contractorsRated",
       (SELECT count_if(bbb_rating IS NOT NULL) FROM pm)::BIGINT                      AS "rowsWithBbbRating";`,
  );
}

function parquetRows(path: string): number {
  return queryRow<{ rows: number }>(
    `SELECT count(*)::BIGINT AS rows FROM read_parquet('${sqlPath(path)}');`,
  ).rows;
}

/* ------------------------------------------------------------------ plan and publish */

/**
 * Everything up to the first byte of upload.
 *
 * Separated so `--dry-run` can report the artifact sizes and coverage a publish would land
 * without writing to `publish/`. The build is deterministic, so what a dry run measures is what
 * a real publish uploads.
 */
export async function planPermitPublish(
  bucket: string,
  options: PublishPermitsOptions,
): Promise<PermitPublishPlan> {
  const report = options.onProgress ?? (() => {});
  const s3 = new S3Client({ region: AWS_REGION });

  const parcelPointer = await getJson<ParcelPointer>(s3, bucket, PUBLISH_POINTER_KEY);
  report(
    `parcel snapshot ${parcelPointer.runId}: ${parcelPointer.parcelCount.toLocaleString('en-US')} parcels`,
  );

  const snapshotPrefix = parcelPointer.snapshotPrefix.replace(`s3://${bucket}/`, '');
  const snapshotObjects = (await listAll(s3, bucket, snapshotPrefix)).filter((object) =>
    object.Key?.endsWith('.parquet'),
  );
  if (snapshotObjects.length === 0) {
    throw new PermitPublishError(`no Parquet under s3://${bucket}/${snapshotPrefix}`);
  }
  const snapshotDir = join(options.workDir, 'snapshot');
  const snapshot = await mirror(s3, bucket, snapshotObjects, snapshotDir, snapshotPrefix);
  report(`snapshot mirrored: ${snapshot.mirrored.length} objects (${snapshot.fetched} fetched)`);

  const censusObjects = censusUnionObjects(await listAll(s3, bucket, CENSUS_PREFIX));
  if (censusObjects.length === 0) {
    throw new PermitPublishError(
      `no accumulated census months under s3://${bucket}/${CENSUS_PREFIX} — ` +
        'the sweep has not landed a dataset-of-record object yet',
    );
  }
  const censusDir = join(options.workDir, 'census');
  const census = await mirror(s3, bucket, censusObjects, censusDir, CENSUS_PREFIX);
  report(
    `census mirrored: ${census.mirrored.length} months, ${mib(census.bytes)} (${census.fetched} fetched)`,
  );

  const coverage = analyseMonthCoverage(
    censusObjects
      .map((object) => monthOf(object.Key ?? ''))
      .filter((month): month is string => month !== null),
  );
  report(
    `census coverage: ${coverage.months} months, ${coverage.firstMonth} to ${coverage.lastMonth}` +
      (coverage.contiguous ? ', contiguous' : `, ${coverage.missingMonths.length} missing`),
  );

  const statusObjects = (await listAll(s3, bucket, STATUS_PREFIX)).filter((object) =>
    object.Key?.endsWith('.ndjson'),
  );
  const statusDir = join(options.workDir, 'status');
  const statusMirror = await mirror(s3, bucket, statusObjects, statusDir, STATUS_PREFIX);
  const statusPath = join(options.workDir, 'status-current.ndjson');
  const status = await flattenStatus(statusMirror.mirrored, statusPath);
  report(
    `status reduced: ${status.rows} observations across ${status.runs} runs -> ` +
      `${status.applications} applications, reference ${status.referenceDate ?? '(none)'}`,
  );

  const bbbPointer = await getJson<BbbPointer>(s3, bucket, BBB_POINTER_KEY);
  const bbbMatchesPath = join(options.workDir, 'bbb-matches.ndjson');
  const bbbHead = await s3.send(
    new HeadObjectCommand({ Bucket: bucket, Key: bbbPointer.matchesKey }),
  );
  const bbbMirror = await mirror(
    s3,
    bucket,
    [
      {
        Key: bbbPointer.matchesKey,
        Size: bbbHead.ContentLength,
        ETag: bbbHead.ETag,
        LastModified: bbbHead.LastModified,
      },
    ],
    dirname(bbbMatchesPath),
    dirname(bbbPointer.matchesKey) + '/',
  );
  const contractorsPath = join(options.workDir, 'contractors-bbb.ndjson');
  const bbb = await flattenContractors(
    join(dirname(bbbMatchesPath), 'matches.ndjson'),
    contractorsPath,
  );
  report(
    `bbb run ${bbbPointer.runId}: ${bbb.searched} contractors searched, ${bbb.matched} matched, ${bbb.rated} rated`,
  );

  /**
   * Content fingerprint of every input object.
   *
   * ETags rather than sizes, so a month re-harvested to the same length still changes the id.
   * Sorted, so listing order cannot change it.
   */
  const fingerprint = createHash('sha256');
  for (const object of [
    ...snapshot.mirrored,
    ...census.mirrored,
    ...statusMirror.mirrored,
    ...bbbMirror.mirrored,
  ]
    .map((object) => `${object.key}:${object.etag}:${object.size}`)
    .sort()) {
    fingerprint.update(`${object}\n`);
  }
  const runId = `permits-${fingerprint.digest('hex').slice(0, 12)}`;
  report(
    `run id ${runId} (fingerprint of ${census.mirrored.length + statusMirror.mirrored.length + snapshot.mirrored.length + 1} input objects)`,
  );

  const buildDir = join(options.workDir, 'build');
  mkdirSync(buildDir, { recursive: true });
  const stats = buildArtifacts(snapshotDir, censusDir, statusPath, contractorsPath, buildDir);
  report(
    `built: ${stats.permitRows.toLocaleString('en-US')} permit rows, ` +
      `${stats.publishedParcels.toLocaleString('en-US')} published parcels with a permit`,
  );

  const prefix = permitsSnapshotPrefix(runId);
  const built = (
    [
      ['permits', 'permits.parquet'],
      ['parcelIndex', 'parcel-index.parquet'],
      ['contractors', 'contractors.parquet'],
    ] as const
  ).map(([field, file]) => {
    const path = join(buildDir, file);
    return {
      field,
      file,
      path,
      key: `${prefix}${file}`,
      bytes: statSync(path).size,
      rows: parquetRows(path),
    };
  });
  for (const artifact of built) {
    report(
      `  ${artifact.file}: ${artifact.rows.toLocaleString('en-US')} rows, ${mib(artifact.bytes)}`,
    );
  }

  const file = (field: string): PublishedPermitFile => {
    const artifact = built.find((candidate) => candidate.field === field);
    if (!artifact) throw new PermitPublishError(`artifact ${field} was not built`);
    return { file: artifact.file, key: artifact.key, bytes: artifact.bytes, rows: artifact.rows };
  };

  const counts: PermitCounts = {
    permitRows: stats.permitRows,
    applications: stats.applications,
    parcels: stats.parcels,
    publishedParcels: stats.publishedParcels,
    roofingPermitRows: stats.roofingPermitRows,
    applicationsWithStatus: status.applications,
    openPermitRows: stats.openPermitRows,
    openRoofingPermitRows: stats.openRoofingPermitRows,
    parcelsWithOpenPermitOverThreeYears: stats.parcelsWithOpenPermitOverThreeYears,
    parcelsWithOpenRoofingPermitOverThreeYears: stats.parcelsWithOpenRoofingPermitOverThreeYears,
    contractorNames: stats.contractorRows,
    rowsWithBbbRating: stats.rowsWithBbbRating,
  };

  const record = permitRecord({
    runId,
    parcelPointer,
    coverage,
    counts,
    status,
    bbb: { ...bbb, runId: bbbPointer.runId },
    malformedParcelIds: stats.malformedParcelIds,
    files: {
      manifest: { file: 'manifest.json', key: `${prefix}manifest.json` },
      permits: file('permits'),
      parcelIndex: file('parcelIndex'),
      contractors: file('contractors'),
    },
    prefix,
  });

  const published = await readPermitsPointer(s3, bucket);

  return {
    s3,
    runId,
    record,
    built,
    published,
    unchanged: published?.runId === runId,
  };
}

export async function publishPermits(
  bucket: string,
  options: PublishPermitsOptions,
): Promise<PermitPublicationRecord> {
  const report = options.onProgress ?? (() => {});
  const plan = await planPermitPublish(bucket, options);

  if (plan.unchanged && options.force !== true) {
    report(`unchanged: ${plan.runId} is already published — nothing uploaded`);
    return plan.record;
  }

  for (const artifact of plan.built) {
    await plan.s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: artifact.key,
        ContentType: 'application/vnd.apache.parquet',
        Body: createReadStream(artifact.path),
        ContentLength: artifact.bytes,
        Metadata: { 'run-id': plan.runId, county: COUNTY },
      }),
    );
    report(`uploaded ${artifact.key} (${mib(artifact.bytes)})`);
  }

  /**
   * Verify before claiming success.
   *
   * A publish step that infers success from the absence of an exception is how an empty
   * `publish/` sat behind two green executions in this repo before. Every object is read back
   * and its length compared to what was built.
   */
  for (const artifact of plan.built) {
    const head = await plan.s3.send(new HeadObjectCommand({ Bucket: bucket, Key: artifact.key }));
    if (head.ContentLength !== artifact.bytes) {
      throw new PermitPublishError(
        `${artifact.key} is ${head.ContentLength} bytes but ${artifact.bytes} were built`,
      );
    }
  }
  report(`verified ${plan.built.length} objects`);

  const announced = await announcePermits(plan.s3, bucket, plan.record);
  report(
    `announced ${announced.manifestKey}, ${announced.pointerKey}, ${announced.parcelPointerKey}`,
  );

  return plan.record;
}

async function readPermitsPointer(
  s3: S3Client,
  bucket: string,
): Promise<PermitPublicationRecord | null> {
  try {
    return await getJson<PermitPublicationRecord>(s3, bucket, PERMITS_POINTER_KEY);
  } catch (error) {
    if ((error as { name?: string }).name === 'NoSuchKey') return null;
    throw error;
  }
}

/**
 * Assemble the manifest.
 *
 * Every coverage note is generated from the numbers beside it rather than written as prose, so
 * a note cannot survive the data it describes changing underneath it — which is the failure
 * mode of hand-written caveats in a dataset that is still being harvested.
 */
function permitRecord(input: {
  runId: string;
  parcelPointer: ParcelPointer;
  coverage: MonthCoverage;
  counts: PermitCounts;
  status: { applications: number; runs: number; referenceDate: string | null };
  bbb: { runId: string; searched: number; matched: number; rated: number };
  malformedParcelIds: number;
  files: PermitPublicationRecord['files'];
  prefix: string;
}): PermitPublicationRecord {
  const { counts, coverage } = input;
  const statusFraction =
    counts.applications === 0
      ? 0
      : Number((input.status.applications / counts.applications).toFixed(6));

  return {
    schema: 'oracle/permits/1',
    version: 1,
    runId: input.runId,
    county: input.parcelPointer.county || COUNTY,
    publishedAt: new Date().toISOString(),
    referenceDate: input.status.referenceDate ?? new Date().toISOString(),
    parcelSnapshot: {
      runId: input.parcelPointer.runId,
      parcelCount: input.parcelPointer.parcelCount,
    },
    prefix: input.prefix,
    files: input.files,
    totals: {
      bytes:
        input.files.permits.bytes + input.files.parcelIndex.bytes + input.files.contractors.bytes,
      objects: 4,
    },
    coverage: {
      census: {
        ...coverage,
        complete: false,
        note:
          `The census sweep is still running. Months ${coverage.firstMonth} to ${coverage.lastMonth} ` +
          `have landed; anything outside that window is unharvested, not absent. ` +
          `${input.malformedParcelIds} permit row(s) carry a parcel id that does not match the ` +
          `county's format and have a null parcel_id.`,
      },
      status: {
        applicationsWithStatus: input.status.applications,
        applicationsTotal: counts.applications,
        fraction: statusFraction,
        runsReduced: input.status.runs,
        note:
          `Lifecycle comes only from the per-permit status detail, which has been harvested for ` +
          `${input.status.applications} of ${counts.applications} applications ` +
          `(${(statusFraction * 100).toFixed(3)}%). Every other permit has status "unknown", which ` +
          `means unharvested and not closed. Filtering "unknown" as if it were closed would ` +
          `understate the open population by orders of magnitude.`,
      },
      bbb: {
        runId: input.bbb.runId,
        contractorsSearched: input.bbb.searched,
        contractorsMatched: input.bbb.matched,
        contractorsRated: input.bbb.rated,
        note:
          `The BBB run searched ${input.bbb.searched} permit contractors and rated ${input.bbb.rated}. ` +
          `The census names ${counts.contractorNames} distinct contractors, so bbb_lookup = ` +
          `"not_searched" is the common case; "searched_no_match" means BBB was searched and has no ` +
          `profile for that business, which is a different fact from nobody having looked.`,
      },
      absenceMeaning: absenceMeaning(coverage),
    },
    counts,
    vocabulary: { status: PERMIT_STATUSES, bbbLookup: BBB_LOOKUPS },
    usage: {
      duckdb:
        "SELECT parcel_id, max_open_roofing_years FROM read_parquet('parcel-index.parquet') " +
        'WHERE open_roofing_permit_count > 0 AND max_open_roofing_years >= 3 ORDER BY max_open_roofing_years DESC;',
    },
  };
}

function mib(bytes: number): string {
  return `${(bytes / 1024 ** 2).toFixed(2)} MiB`;
}
