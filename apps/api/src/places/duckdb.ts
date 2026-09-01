/**
 * Thin wrapper around the DuckDB CLI.
 *
 * Shelling out rather than embedding a binding, for the same reason the publish tier does:
 * DuckDB is a named requirement of this milestone and the demo recipe runs the same binary,
 * so the artifact a presenter queries must have been written by the engine they query it
 * with. A second, differently versioned copy as an npm dependency would break that.
 *
 * Duplicated from `src/publish/duckdb.ts` rather than imported. That module belongs to the
 * publish tier, and this tier needs two things it does not have — a `spatial` + `httpfs`
 * preamble, and multi-row queries — neither of which is this tier's to add to someone
 * else's module. The duplicated surface is about thirty lines.
 */
import { execFileSync } from 'node:child_process';

const DUCKDB_BIN = process.env.DUCKDB_BIN ?? 'duckdb';

class DuckDbError extends Error {
  override readonly name = 'DuckDbError';
}

/**
 * `spatial` for `ST_Read`/`ST_Within`, `httpfs` for the public Overture bucket.
 *
 * `s3_region` is set but no credentials are configured, and that is deliberate: the bucket
 * is public, so an unsigned request is the correct request. If a developer happens to have
 * AWS credentials in the environment, DuckDB would otherwise sign requests to a bucket
 * their account has no relationship with.
 */
/**
 * `DUCKDB_EXTENSION_DIR` points at a directory the extensions are *already* in, and
 * `DUCKDB_TEMP_DIR` at somewhere writable to spill to. Both are unset for a local run and
 * both are set by the container image, which is the whole reason they exist: a Lambda
 * filesystem is read-only apart from `/tmp`, so DuckDB's default `~/.duckdb` install path
 * and its default spill location beside the database file are unavailable.
 *
 * `INSTALL` against a directory that already holds the extension is a no-op, so the same
 * preamble works either way — but the image builds the extensions in rather than letting a
 * run reach the extension repository, because a scheduled run must not depend on a third
 * party being up.
 */
function environmentPreamble(): string {
  const lines: string[] = [];
  const extensionDir = process.env.DUCKDB_EXTENSION_DIR;
  if (extensionDir) lines.push(`SET extension_directory = ${sqlString(extensionDir)};`);
  const tempDir = process.env.DUCKDB_TEMP_DIR;
  if (tempDir) lines.push(`SET temp_directory = ${sqlString(tempDir)};`);
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}

const EXTENSION_PREAMBLE = [
  'INSTALL httpfs;',
  'INSTALL spatial;',
  'LOAD httpfs;',
  'LOAD spatial;',
  `SET s3_region = 'us-west-2';`,
  'SET s3_use_ssl = true;',
  /**
   * Emptied rather than left to default. httpfs signs a request whenever it has an access
   * key, and in Lambda it always would — the execution role's credentials are in the
   * environment. A signed request from an identity with no relationship to
   * `overturemaps-us-west-2` is answered with AccessDenied, so the credentials that make
   * this tier work in Lambda are the ones it is told to ignore.
   */
  `SET s3_access_key_id = '';`,
  `SET s3_secret_access_key = '';`,
  `SET s3_session_token = '';`,
].join('\n');

/**
 * `SET threads TO 1` is not a performance choice, it is what makes a written artifact
 * reproducible: a multi-threaded `COPY … TO` Parquet interleaves row groups
 * non-deterministically, so the same query emits different bytes and therefore a different
 * CID, and the publish step can no longer recognise "nothing changed".
 *
 * It is applied only to writes. The extract itself is a network scan of the whole places
 * theme where single-threading costs minutes for no benefit — nothing about the *count* it
 * produces depends on thread count.
 */
const SINGLE_THREADED = 'SET threads TO 1;';

export interface RunOptions {
  /** Path to a persistent database file. Omit for an in-memory session. */
  database?: string;
  /** Force reproducible output. Use for anything that writes a file. */
  deterministic?: boolean;
}

function argsFor(options: RunOptions, extra: readonly string[]): string[] {
  return options.database ? [options.database, ...extra] : [...extra];
}

function script(sql: string, options: RunOptions): string {
  const preamble = options.deterministic
    ? `${EXTENSION_PREAMBLE}\n${SINGLE_THREADED}\n`
    : `${EXTENSION_PREAMBLE}\n`;
  return `${environmentPreamble()}${preamble}${sql}`;
}

export function runSql(sql: string, options: RunOptions = {}): void {
  try {
    execFileSync(DUCKDB_BIN, argsFor(options, ['-c', script(sql, options)]), {
      stdio: ['ignore', 'ignore', 'pipe'],
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch (error) {
    throw new DuckDbError(describeFailure(error));
  }
}

export function query<T>(sql: string, options: RunOptions = {}): T[] {
  let raw: string;
  try {
    raw = execFileSync(DUCKDB_BIN, argsFor(options, ['-json', '-c', script(sql, options)]), {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch (error) {
    throw new DuckDbError(describeFailure(error));
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) return [];
  return JSON.parse(trimmed) as T[];
}

export function queryRow<T>(sql: string, options: RunOptions = {}): T {
  const rows = query<T>(sql, options);
  if (rows.length !== 1) {
    throw new DuckDbError(`expected exactly one row, got ${rows.length}`);
  }
  return rows[0] as T;
}

/** Single-quote a string for interpolation into SQL. */
export function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function describeFailure(error: unknown): string {
  const detail = error as { stderr?: string; message?: string; code?: string };
  if (detail.code === 'ENOENT') {
    return `${DUCKDB_BIN} not found on PATH — install DuckDB or set DUCKDB_BIN`;
  }
  return (detail.stderr ?? detail.message ?? String(error)).trim();
}
