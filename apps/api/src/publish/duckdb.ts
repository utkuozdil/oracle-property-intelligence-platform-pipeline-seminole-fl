import { execFileSync } from 'node:child_process';

/**
 * Thin wrapper around the DuckDB CLI.
 *
 * The publish step shells out rather than embedding a DuckDB binding because DuckDB is
 * already a hard requirement of this milestone — the assignment names it as the query
 * layer, and the demo recipe runs the same binary. Adding a second, differently
 * versioned copy of the engine as an npm dependency would mean the artifact the
 * presenter queries was written by an engine other than the one they query it with.
 */

const DUCKDB_BIN = process.env.DUCKDB_BIN ?? 'duckdb';

class DuckDbError extends Error {
  override readonly name = 'DuckDbError';
}

/**
 * `SET threads TO 1` is not a performance choice, it is what makes the output
 * reproducible.
 *
 * Idempotency in this pipeline rests on the root CID: re-publishing unchanged data must
 * produce the same CID so the step can skip the upload. A multi-threaded `COPY … TO`
 * Parquet interleaves row groups non-deterministically, so the same query would emit
 * different bytes, a different CID, and a pointless full re-upload every night. Single
 * threaded plus an explicit `ORDER BY` was verified byte-identical across runs.
 */
const REPRODUCIBLE_PREAMBLE = 'SET threads TO 1;\n';

export function runSql(script: string): void {
  try {
    execFileSync(DUCKDB_BIN, ['-c', REPRODUCIBLE_PREAMBLE + script], {
      stdio: ['ignore', 'ignore', 'pipe'],
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    throw new DuckDbError(describeFailure(error));
  }
}

/** Run a single-row query and return it parsed. */
export function queryRow<T>(sql: string): T {
  let raw: string;
  try {
    raw = execFileSync(DUCKDB_BIN, ['-json', '-c', REPRODUCIBLE_PREAMBLE + sql], {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    throw new DuckDbError(describeFailure(error));
  }

  const rows = JSON.parse(raw) as T[];
  if (rows.length !== 1) {
    throw new DuckDbError(`expected exactly one row, got ${rows.length}`);
  }
  return rows[0] as T;
}

function describeFailure(error: unknown): string {
  const detail = error as { stderr?: string; message?: string; code?: string };
  if (detail.code === 'ENOENT') {
    return `${DUCKDB_BIN} not found on PATH — install DuckDB or set DUCKDB_BIN`;
  }
  return (detail.stderr ?? detail.message ?? String(error)).trim();
}
