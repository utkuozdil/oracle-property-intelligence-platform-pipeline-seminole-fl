import { spawn } from 'node:child_process';

/**
 * Thin async wrapper around the DuckDB CLI.
 *
 * Shelling out rather than binding a second copy of the engine follows the choice the
 * publish step already made in `apps/api/src/publish/duckdb.ts`: DuckDB is a stated
 * requirement of this milestone, `just duckdb-demo` runs the same binary, and the
 * published Parquet was *written* by it. An MCP server that answered with a differently
 * versioned embedded engine would be demonstrating something other than the query path
 * the assignment claims.
 *
 * It also keeps the package free of a ~100 MB native dependency, which matters when the
 * deliverable is "clone and run" for a consumer we do not control.
 */

export class DuckDbError extends Error {
  override readonly name = 'DuckDbError';
}

export interface DuckDbOptions {
  bin: string;
  /** Set when a query reads `s3://` URIs and must pick up the caller's AWS credentials. */
  s3: boolean;
  timeoutMs?: number;
}

/**
 * `httpfs` is what makes the whole design work: it range-reads Parquet row groups over
 * HTTP, so a query touches a fraction of the 22 MB file instead of downloading it.
 *
 * `INSTALL` is a no-op once the extension is on disk, so paying for it on every call
 * costs nothing and removes a first-run setup step from the consumer's instructions.
 *
 * The setup runs under `.mode trash` because `CREATE SECRET` returns a `Success` row.
 * In JSON mode that row is printed as its own array ahead of the real result, and two
 * concatenated JSON documents are not parseable — the failure looks like a corrupt
 * answer rather than a chatty preamble.
 */
function script(sql: string, options: DuckDbOptions): string {
  const setup = ['.mode trash', 'INSTALL httpfs;', 'LOAD httpfs;'];
  if (options.s3) {
    // `credential_chain` defers to the ambient AWS config — the same profile the operator
    // already uses. No key material is read, held or logged by this server.
    const region = process.env.AWS_REGION?.trim() || 'us-east-2';
    setup.push(
      'INSTALL aws;',
      'LOAD aws;',
      `CREATE OR REPLACE SECRET oracle_s3 (TYPE s3, PROVIDER credential_chain, REGION '${region}');`,
    );
  }
  return `${setup.join('\n')}\n.mode json\n${sql}\n`;
}

/**
 * Run a query and return its rows parsed from DuckDB's JSON output.
 *
 * Piped over stdin rather than passed as `-c`, because the CLI treats a `-c` argument as
 * a single command and rejects the dot-commands the output mode needs.
 */
export function queryRows<T>(sql: string, options: DuckDbOptions): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(options.bin, ['-batch'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new DuckDbError(describeFailure({ killed: true }, options.bin)));
    }, options.timeoutMs ?? 120_000);

    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new DuckDbError(describeFailure(error, options.bin)));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const errorText = Buffer.concat(stderr).toString('utf8').trim();
      if (code !== 0) {
        reject(new DuckDbError(errorText === '' ? `duckdb exited with ${code}` : errorText));
        return;
      }
      const text = Buffer.concat(stdout).toString('utf8').trim();
      if (text === '') {
        resolve([]);
        return;
      }
      try {
        resolve(JSON.parse(text) as T[]);
      } catch {
        reject(new DuckDbError(`could not parse DuckDB output: ${text.slice(0, 400)}`));
      }
    });

    child.stdin.end(script(sql, options));
  });
}

export async function queryOne<T>(sql: string, options: DuckDbOptions): Promise<T | null> {
  const rows = await queryRows<T>(sql, options);
  return rows[0] ?? null;
}

function describeFailure(error: unknown, bin: string): string {
  const detail = error as { stderr?: string; message?: string; code?: string; killed?: boolean };
  if (detail.code === 'ENOENT') {
    return (
      `${bin} not found on PATH. This server queries the published Parquet with DuckDB; ` +
      'install it (`brew install duckdb`, `winget install DuckDB.cli`, or see duckdb.org/docs/installation) ' +
      'or set DUCKDB_BIN to its location.'
    );
  }
  if (detail.killed) {
    return 'DuckDB timed out. A public IPFS gateway can be slow on a cold block; retry, or set ORACLE_MCP_PARQUET_URL to a local copy of the Parquet.';
  }
  return (detail.stderr ?? detail.message ?? String(error)).trim();
}

/** Escape a string for inlining as a SQL literal. */
export function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Escape a value destined for a SQL literal that DuckDB will also read as a file path.
 *
 * Tool inputs never reach this — only configured URIs do — but a path is still the one
 * place where a stray quote turns a read into arbitrary SQL, so it is escaped rather
 * than trusted.
 */
export function sqlPath(value: string): string {
  return sqlString(value);
}
