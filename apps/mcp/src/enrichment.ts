import type { EnrichmentConfig } from './config';
import { queryOne, sqlPath } from './duckdb';
import type { DuckDbOptions } from './duckdb';

/**
 * Permit and BBB enrichment from the published S3 snapshot.
 *
 * The IPFS query table has no permit or BBB columns. Those live in
 * `publish/permits/current.json` → `permits.parquet`, the same generation the API and
 * Radius search read. Status is the publisher's four-value lifecycle (`open` / `closed` /
 * `void` / `unknown`). `unknown` means the status detail has not been harvested — it is
 * not open, and it is not closed.
 */

export interface EnrichmentStatus {
  permits: SourceStatus;
  bbb: SourceStatus;
}

export interface SourceStatus {
  available: boolean;
  source: string | null;
  reason: string;
}

export interface ResolvedPermits {
  parquetUri: string;
  pointerUri: string;
  runId: string | null;
  publishedAt: string | null;
  referenceDate: string | null;
}

const PERMITS_UNSET =
  'Permit history is not in the IPFS query table. The UI reads a published S3 snapshot ' +
  '(publish/permits/current.json). This copy has no pointer to that snapshot, so open-roofing ' +
  'and contractor questions are unanswered — not answered as zero. Set ORACLE_DATA_BUCKET or ' +
  'ORACLE_PERMIT_POINTER_URI if you have access.';

const BBB_UNSET =
  'BBB ratings travel with the published permit snapshot (bbb_lookup, bbb_rating). This copy ' +
  'cannot see that snapshot.';

const PERMITS_SET =
  'Reading the published permit snapshot (not the IPFS query table). Status "unknown" is ' +
  'unharvested and is not treated as open.';

const BBB_SET =
  'BBB ratings are columns on the published permit snapshot. A missing rating is not a poor one.';

export function describeEnrichment(config: EnrichmentConfig): EnrichmentStatus {
  const available = config.permitPointerUri !== null;
  return {
    permits: {
      available,
      source: config.permitPointerUri,
      reason: available ? PERMITS_SET : PERMITS_UNSET,
    },
    bbb: {
      available,
      source: config.permitPointerUri,
      reason: available ? BBB_SET : BBB_UNSET,
    },
  };
}

/** True when any configured source needs the caller's AWS credentials. */
export function needsS3(config: EnrichmentConfig): boolean {
  return config.permitPointerUri !== null && config.permitPointerUri.startsWith('s3://');
}

/**
 * Reconcile the two spellings of a Seminole parcel id.
 *
 * The permit portal writes `15-21-29-527-0000-0140`; the published table writes
 * `15212952700000140`. Applied to tool input as well as to the join.
 */
export const PARCEL_KEY_SQL = (column: string): string => `upper(replace(${column}, '-', ''))`;

export function normaliseParcelId(value: string): string {
  return value.replace(/-/g, '').toUpperCase();
}

/**
 * Confirmed-open roofing rows from the published permit Parquet.
 *
 * `status = 'open'` only. `unknown` is excluded here, matching the API: unharvested is
 * not treated as an open job.
 */
export function openRoofingCte(parquetUri: string): string {
  return `open_permits AS (
    SELECT ${PARCEL_KEY_SQL('parcel_id')} AS parcelKey,
           application_no,
           permit_type,
           description,
           issued_on::VARCHAR AS issued_on,
           status,
           contractor_name,
           open_years,
           open_duration_observed_at::VARCHAR AS observed_at,
           bbb_lookup,
           bbb_rating,
           bbb_rating_score
    FROM read_parquet(${sqlPath(parquetUri)})
    WHERE roofing_relevant
      AND status = 'open'
      AND open_years IS NOT NULL
  )`;
}

export function uriLooksLikeParquet(uri: string): boolean {
  return /\.parquet(\?|$)/i.test(uri);
}

function s3UriFromPointer(pointerUri: string, key: string): string {
  if (pointerUri.startsWith('s3://')) {
    const bucket = pointerUri.slice(5).split('/')[0];
    return `s3://${bucket}/${key}`;
  }
  return pointerUri.replace(/[^/]+$/, key.split('/').at(-1) ?? '');
}

/**
 * Follow `publish/permits/current.json` to the Parquet generation it names.
 *
 * A `.parquet` URI is used as-is so a local fixture does not need a pointer.
 */
export async function resolvePermitSource(
  uri: string,
  options: DuckDbOptions,
): Promise<ResolvedPermits> {
  if (uriLooksLikeParquet(uri)) {
    return {
      parquetUri: uri,
      pointerUri: uri,
      runId: null,
      publishedAt: null,
      referenceDate: null,
    };
  }

  const pointer = await queryOne<{
    permits_key?: string;
    run_id?: string;
    published_at?: string;
    reference_date?: string;
  }>(
    `SELECT files.permits.key AS permits_key,
            runId AS run_id,
            publishedAt AS published_at,
            referenceDate AS reference_date
     FROM read_json_auto(${sqlPath(uri)});`,
    options,
  );

  if (pointer?.permits_key === undefined || pointer.permits_key === '') {
    throw new Error(`${uri} does not name files.permits.key`);
  }

  return {
    parquetUri: s3UriFromPointer(uri, pointer.permits_key),
    pointerUri: uri,
    runId: pointer.run_id ?? null,
    publishedAt: pointer.published_at ?? null,
    referenceDate: pointer.reference_date ?? null,
  };
}
