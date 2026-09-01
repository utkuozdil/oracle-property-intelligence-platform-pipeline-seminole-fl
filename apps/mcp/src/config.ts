import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Configuration for the open-data MCP server.
 *
 * Every default here points at data that is already public. The server needs no AWS
 * credentials, no database and no deployed endpoint to answer its core tools, which is
 * the whole reason it can be handed to an outside agent as a package rather than a URL.
 *
 * Permit history and BBB ratings live in the published S3 permit snapshot
 * (`publish/permits/current.json`), not in the IPFS query table. They are opt-in, off
 * unless `ORACLE_DATA_BUCKET` or `ORACLE_PERMIT_POINTER_URI` is set, and their absence
 * is reported rather than flattened into an empty result.
 */

/** The published Seminole County IPNS name. Stable across re-publishes. */
const DEFAULT_IPNS = 'k51qzi5uqu5di4rwv9bhnuzrg6xrxsugpjq8y85zhsgethars962cmosaqbh8i';

/**
 * `ipfs.io` rather than `ipfs.filebase.io`: the Filebase gateway caches per path with
 * `max-age=300` and was measured serving three generations of one IPNS name at once, so
 * a reader can silently get a superseded snapshot. The publish step verifies against
 * `ipfs.io` for the same reason.
 */
const DEFAULT_GATEWAY = 'https://ipfs.io';

/** Path of the query table inside the published root. */
export const QUERY_TABLE_PATH = 'query-table/seminole.parquet';

/** Path of the query table's manifest, which carries row counts and provenance. */
export const MANIFEST_PATH = 'query-table/manifest.json';

export interface EnrichmentConfig {
  /**
   * The published permit pointer (`publish/permits/current.json`) or a direct
   * `permits.parquet`. Same snapshot the API and Radius search read.
   */
  permitPointerUri: string | null;
}

export interface ServerConfig {
  ipnsName: string;
  gateway: string;
  /** Full URL (or local path) of the Parquet the tools query. */
  parquetSource: string;
  /** Whether `parquetSource` was overridden, in which case IPNS is not in the path. */
  parquetOverridden: boolean;
  manifestUrl: string;
  /** Directory holding CID-keyed copies of the published Parquet; null disables caching. */
  cacheDir: string | null;
  duckdbBin: string;
  enrichment: EnrichmentConfig;
  /** Upper bound on rows any single tool call may return. */
  maxLimit: number;
}

function ipnsUrl(gateway: string, ipnsName: string, path: string): string {
  return `${gateway.replace(/\/+$/, '')}/ipns/${ipnsName}/${path}`;
}

function optional(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env[name]?.trim();
  return value === undefined || value === '' ? null : value;
}

function permitPointerFromBucket(bucket: string | null): string | null {
  if (bucket === null) return null;
  return `s3://${bucket}/publish/permits/current.json`;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const ipnsName = env.ORACLE_OPEN_DATA_IPNS?.trim() || DEFAULT_IPNS;
  const gateway = (env.ORACLE_OPEN_DATA_GATEWAY?.trim() || DEFAULT_GATEWAY).replace(/\/+$/, '');

  /**
   * The override exists because a public gateway is a third party that can be slow or
   * down mid-demo. It takes a local Parquet path just as happily as a URL.
   *
   * It must name the `.parquet` file. Pointing DuckDB at a directory CID fails with
   * "No magic bytes found", which reads like a corrupt file rather than a wrong path.
   */
  const override = env.ORACLE_MCP_PARQUET_URL?.trim();

  const cacheSetting = env.ORACLE_MCP_CACHE_DIR?.trim();
  const cacheDir =
    cacheSetting === 'off'
      ? null
      : (cacheSetting ?? join(homedir(), '.cache', 'oracle-seminole-mcp'));

  return {
    ipnsName,
    gateway,
    parquetSource: override || ipnsUrl(gateway, ipnsName, QUERY_TABLE_PATH),
    parquetOverridden: Boolean(override),
    manifestUrl: ipnsUrl(gateway, ipnsName, MANIFEST_PATH),
    cacheDir,
    duckdbBin: env.DUCKDB_BIN?.trim() || 'duckdb',
    enrichment: {
      permitPointerUri:
        optional('ORACLE_PERMIT_POINTER_URI', env) ??
        optional('ORACLE_PERMIT_STATUS_URI', env) ??
        permitPointerFromBucket(optional('ORACLE_DATA_BUCKET', env)),
    },
    maxLimit: Number(env.ORACLE_MCP_MAX_LIMIT ?? 200),
  };
}
