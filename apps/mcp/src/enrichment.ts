import type { EnrichmentConfig } from './config';
import { queryOne, sqlPath } from './duckdb';
import type { DuckDbOptions } from './duckdb';

/**
 * Permit and BBB enrichment — the two things the headline demo question needs that the
 * published dataset does not yet contain.
 *
 * The published query table has 55 columns and none of them is a permit or a BBB rating.
 * Those live in the pipeline's private S3 bucket, still being swept. That is a real gap,
 * and the honest options are (a) say so, or (b) let an operator who *does* have bucket
 * access point the server at them explicitly. This module does both: unset by default,
 * with every tool response carrying the reason.
 *
 * This is the same boundary the open-data MCP skill draws around on-demand permit
 * harvesting: a co-located deployment can reach private pipeline state, a remote
 * consumer's copy cannot, and the difference is declared rather than hidden.
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

const PERMITS_UNSET =
  'Permit history is not part of the published IPFS dataset — the query table has no permit ' +
  'columns, and the county permit sweep is still running into private staging. This server ' +
  'therefore cannot tell you whether a property has an open roofing permit, and an empty ' +
  'permit list here means "not published", not "no permits". Set ORACLE_PERMIT_STATUS_URI to a ' +
  'DuckDB-readable NDJSON location if you have access to the staged sweep.';

const BBB_UNSET =
  'BBB contractor ratings are not part of the published IPFS dataset. Set ORACLE_BBB_POINTER_URI ' +
  'to the contractor-ratings pointer object (current.json) if you have access to it.';

export function describeEnrichment(config: EnrichmentConfig): EnrichmentStatus {
  return {
    permits: {
      available: config.permitStatusUri !== null,
      source: config.permitStatusUri,
      reason:
        config.permitStatusUri === null
          ? PERMITS_UNSET
          : 'Reading a staged permit-status sweep outside the published dataset. Coverage is ' +
            'whatever that sweep covered, which is not the whole county.',
    },
    bbb: {
      available: config.bbbPointerUri !== null,
      source: config.bbbPointerUri,
      reason:
        config.bbbPointerUri === null
          ? BBB_UNSET
          : 'Reading BBB ratings through the contractor-ratings pointer, outside the published ' +
            'dataset. Only contractors BBB lists are rated; an absent rating is not a bad rating.',
    },
  };
}

/** True when any configured source needs the caller's AWS credentials. */
export function needsS3(config: EnrichmentConfig): boolean {
  return [config.permitStatusUri, config.bbbPointerUri].some(
    (uri) => uri !== null && uri.startsWith('s3://'),
  );
}

/**
 * Normalise a contractor name to a join key, as a SQL expression.
 *
 * Permit records and BBB records name the same company differently: `3MG ROOFING
 * (CCC-ANGIULLI)` against `3MG Roofing & Solar`, `PREMIER ROOFING UNLIMITED, INC` against
 * `Premier Roofing Unlimited, Inc.`. The BBB matcher upstream already publishes its own
 * key, but reproducing its exact normaliser here would couple this server to another
 * component's private logic, so both sides are normalised the same way *by this
 * function* instead: upper case, drop parentheticals, drop punctuation, drop a trailing
 * corporate suffix, collapse whitespace.
 *
 * It is a heuristic and it is reported as one — `contractorMatch: 'normalized-name'` on
 * every enriched row, so a consumer can see the join was fuzzy.
 */
export function contractorKey(column: string): string {
  const withoutParens = `regexp_replace(upper(${column}), '\\(.*?\\)', ' ', 'g')`;
  const alphanumeric = `regexp_replace(${withoutParens}, '[^A-Z0-9 ]', ' ', 'g')`;
  const collapsed = `trim(regexp_replace(${alphanumeric}, ' +', ' ', 'g'))`;
  const suffixes = 'INC|INCORPORATED|LLC|L L C|CO|COMPANY|CORP|CORPORATION|LTD|LP|PA|PLLC';
  return `trim(regexp_replace(${collapsed}, ' (${suffixes})$', '', 'g'))`;
}

/**
 * Reconcile the two spellings of a Seminole parcel id.
 *
 * The permit portal writes `15-21-29-527-0000-0140`; the published table writes
 * `15212952700000140`. They are the same 17 characters with the county's separators
 * removed — verified by joining the staged sweep both ways: 0 of 17 open roofing permits
 * matched on the raw string, 16 of 17 matched after stripping. (The seventeenth names a
 * parcel that is not in the published snapshot at all, which is itself worth knowing.)
 *
 * Applied to tool input as well as to the join, so an agent holding a permit-format id
 * gets an answer instead of a lookup miss.
 */
export const PARCEL_KEY_SQL = (column: string): string => `upper(replace(${column}, '-', ''))`;

export function normaliseParcelId(value: string): string {
  return value.replace(/-/g, '').toUpperCase();
}

/**
 * A `permits` CTE over the staged sweep.
 *
 * The sweep is written one object per run with no `current.json` pointer, so a location
 * covering several runs can hold the same permit twice. Deduplicating on `appNo`,
 * preferring the row that carries a close date and then the newest file, keeps a permit
 * from being counted twice as open.
 */
export function permitsCte(uri: string): string {
  return `permits AS (
    SELECT appNo,
           parcelId,
           ${PARCEL_KEY_SQL('parcelId')}       AS parcelKey,
           applicationDate::DATE               AS applicationDate,
           applicationType,
           rawStatus,
           canonicalStatus,
           lifecycle,
           coalesce(terminal, FALSE)           AS terminal,
           coalesce(roofingRelevant, FALSE)    AS roofingRelevant,
           coalesce(generalContractor, tenantName) AS contractorName,
           valuationUsd
    FROM read_json_auto(${sqlPath(uri)}, format = 'newline_delimited',
                        union_by_name = TRUE, filename = TRUE)
    QUALIFY row_number() OVER (
      PARTITION BY appNo ORDER BY (closedDate IS NOT NULL) DESC, filename DESC
    ) = 1
  )`;
}

/** A `bbb` CTE over the matches file named by the contractor-ratings pointer. */
export function bbbCte(matchesUri: string): string {
  return `bbb AS (
    SELECT ${contractorKey('permitContractorName')} AS contractor_key,
           any_value(bbbBusinessName)               AS bbbBusinessName,
           any_value(rating)                        AS bbbRating,
           any_value(accredited)                    AS bbbAccredited,
           any_value(profileUrl)                    AS bbbProfileUrl,
           max(confidence)                          AS bbbMatchConfidence
    FROM read_json_auto(${sqlPath(matchesUri)}, format = 'newline_delimited', union_by_name = TRUE)
    WHERE matched
    GROUP BY 1
  )`;
}

interface Pointer {
  matchesKey?: string;
  runId?: string;
  generatedAt?: string;
  matchedContractorCount?: number;
}

export interface ResolvedBbb {
  matchesUri: string;
  runId: string | null;
  generatedAt: string | null;
  matchedContractorCount: number | null;
}

/**
 * Follow the contractor-ratings pointer to the run it names.
 *
 * Deliberately not a glob over the prefix: superseded runs are left in place beside the
 * current one, and a glob silently unions a 1,248-business run with a 470-business one.
 * The pointer is the only thing that says which run is current.
 */
export async function resolveBbb(pointerUri: string, options: DuckDbOptions): Promise<ResolvedBbb> {
  const pointer = await queryOne<Pointer>(
    `SELECT * FROM read_json_auto(${sqlPath(pointerUri)});`,
    options,
  );
  if (pointer?.matchesKey === undefined) {
    throw new Error(`${pointerUri} does not name a matchesKey`);
  }

  const bucket = pointerUri.startsWith('s3://') ? pointerUri.slice(5).split('/')[0] : null;
  const matchesUri =
    bucket === null
      ? pointerUri.replace(/[^/]+$/, pointer.matchesKey.split('/').at(-1) ?? '')
      : `s3://${bucket}/${pointer.matchesKey}`;

  return {
    matchesUri,
    runId: pointer.runId ?? null,
    generatedAt: pointer.generatedAt ?? null,
    matchedContractorCount: pointer.matchedContractorCount ?? null,
  };
}
