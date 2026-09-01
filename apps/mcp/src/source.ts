import { createWriteStream } from 'node:fs';
import { mkdir, rename, stat, unlink } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';
import type { ServerConfig } from './config';

/**
 * Resolution and local caching of the published query table.
 *
 * The published dataset is content-addressed, which makes caching trivially safe: the
 * cache key *is* the CID of the file, so a re-publish flips the IPNS name to a new CID,
 * misses the cache, and re-downloads. There is no TTL to tune and no way to serve stale
 * data without noticing — the CID a tool reports is the CID it read.
 *
 * Without a cache, every tool call pays gateway latency: a `count(*)` through `ipfs.io`
 * was measured at 9.2 s cold. With one, the first call pays a download and the rest run
 * against local bytes in tens of milliseconds. Both numbers are reported by
 * `describe_dataset` rather than asserted here.
 */

export class SourceError extends Error {
  override readonly name = 'SourceError';
}

export interface SourceState {
  /** What DuckDB is pointed at: a local cached file, or the gateway URL. */
  path: string;
  /** True when `path` is a local file. */
  local: boolean;
  /** CID of the Parquet file itself, when the gateway disclosed it. */
  cid: string | null;
  /** The IPNS-addressed URL, even when reading from cache. */
  url: string;
  bytes: number | null;
  /** How the current `path` came to be, for the record an agent sees. */
  resolution: string;
  resolveMs: number;
}

export interface QueryTableManifest {
  rows?: number;
  columns?: number;
  publishedAt?: string;
  runId?: string;
  rowsWithRoofAge?: number;
  rowsWithCoordinates?: number;
  roofsOlderThan15Years?: number;
  coverage?: string;
  sortedBy?: string[];
  bytes?: number;
  provenance?: Record<string, unknown>;
}

/**
 * The last element of `x-ipfs-roots` is the CID of the addressed file.
 *
 * The header names every root a request traversed — root directory, dataset directory,
 * then the file — which is also what distinguishes "content missing" from "IPNS still
 * pointing at the previous run".
 */
function fileCidFrom(headers: Headers): string | null {
  const roots = headers.get('x-ipfs-roots');
  if (roots === null) return null;
  const parts = roots.split(',').map((part) => part.trim());
  return parts.at(-1) ?? null;
}

async function probe(url: string): Promise<{ cid: string | null; bytes: number | null }> {
  // A four-byte range request: cheap, and the response also proves the path really is a
  // Parquet file rather than the directory above it, which fails later and confusingly.
  const response = await fetch(url, { redirect: 'follow', headers: { Range: 'bytes=0-3' } });
  if (response.status !== 206 && response.status !== 200) {
    throw new SourceError(`${url} returned ${response.status}`);
  }
  const magic = Buffer.from(await response.arrayBuffer()).toString('ascii');
  if (magic !== 'PAR1') {
    throw new SourceError(
      `${url} does not start with Parquet magic bytes (got ${JSON.stringify(magic)}). ` +
        'A directory CID reads this way — the URL must name the .parquet file itself.',
    );
  }

  const range = response.headers.get('content-range');
  const total = range?.split('/').at(-1);
  return {
    cid: fileCidFrom(response.headers),
    bytes: total !== undefined && /^\d+$/.test(total) ? Number(total) : null,
  };
}

async function download(url: string, destination: string): Promise<void> {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || response.body === null) {
    throw new SourceError(`${url} returned ${response.status} while downloading`);
  }
  // Written to a temp name and renamed, so an interrupted download can never be picked
  // up as a complete cache entry on the next run.
  const temporary = `${destination}.partial`;
  try {
    await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary));
    await rename(temporary, destination);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function fileSize(path: string): Promise<number | null> {
  try {
    return (await stat(path)).size;
  } catch {
    return null;
  }
}

export class PublishedDataset {
  private state: SourceState | null = null;
  private manifest: QueryTableManifest | null = null;

  constructor(private readonly config: ServerConfig) {}

  /** Resolve once per process; every tool awaits the same promise-free memoised state. */
  async resolve(): Promise<SourceState> {
    if (this.state !== null) return this.state;
    const startedAt = Date.now();

    if (this.config.parquetOverridden && !/^https?:/i.test(this.config.parquetSource)) {
      this.state = {
        path: this.config.parquetSource,
        local: true,
        cid: null,
        url: this.config.parquetSource,
        bytes: await fileSize(this.config.parquetSource),
        resolution: 'ORACLE_MCP_PARQUET_URL override — local file, IPNS not consulted',
        resolveMs: Date.now() - startedAt,
      };
      return this.state;
    }

    const url = this.config.parquetSource;
    const { cid, bytes } = await probe(url);

    if (this.config.cacheDir === null || cid === null) {
      this.state = {
        path: url,
        local: false,
        cid,
        url,
        bytes,
        resolution:
          cid === null
            ? 'streaming from the gateway — no CID disclosed, so nothing safe to cache under'
            : 'streaming from the gateway — caching disabled (ORACLE_MCP_CACHE_DIR=off)',
        resolveMs: Date.now() - startedAt,
      };
      return this.state;
    }

    await mkdir(this.config.cacheDir, { recursive: true });
    const cached = join(this.config.cacheDir, `${cid}.parquet`);
    const existing = await fileSize(cached);
    if (existing === null) {
      await download(url, cached);
    }

    this.state = {
      path: cached,
      local: true,
      cid,
      url,
      bytes: (await fileSize(cached)) ?? bytes,
      resolution:
        existing === null
          ? `downloaded and cached under its own CID (${cid})`
          : `served from the CID-keyed cache (${cid}); a re-publish changes the CID and invalidates it`,
      resolveMs: Date.now() - startedAt,
    };
    return this.state;
  }

  /** The DuckDB table expression every query reads from. */
  async table(): Promise<string> {
    const state = await this.resolve();
    return `read_parquet('${state.path.replace(/'/g, "''")}')`;
  }

  /**
   * The publisher's own manifest, read from the same IPFS directory as the data.
   *
   * Row counts and coverage are quoted from it rather than recomputed so that what an
   * agent is told about the dataset comes from the publisher, not from this server's
   * assumptions about it.
   */
  async publishedManifest(): Promise<QueryTableManifest | null> {
    if (this.manifest !== null) return this.manifest;
    if (this.config.parquetOverridden) return null;
    try {
      const response = await fetch(this.config.manifestUrl, { redirect: 'follow' });
      if (!response.ok) return null;
      this.manifest = (await response.json()) as QueryTableManifest;
      return this.manifest;
    } catch {
      return null;
    }
  }
}
