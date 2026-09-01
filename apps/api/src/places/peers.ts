/**
 * Reading the peer tiers this join depends on.
 *
 * Two hops need someone else's output: permit contractor names from the permit tier, and
 * harvested businesses and ratings from the BBB tier. Locally those are directories left
 * behind by another tier's run; in Lambda they are S3 prefixes in the shared data bucket.
 * The prefixes are the same strings either way, so this module is one implementation over
 * two readers rather than two code paths.
 *
 * Absence is a first-class answer. Every loader reports what it found *and where it looked*,
 * because a match rate against 47 fixture-derived names and one against a full county census
 * are different measurements and must never be quoted as if they were the same.
 */
import { existsSync, readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DATA_PREFIXES } from '@oracle-seminole/shared';
import type { BbbBusinessRecord, ContractorRatingMatch } from '../bbb/model';
import type { PeerReader } from './objects';
import type { PermitContractorName } from './roofing-join';

const PERMIT_CENSUS_PREFIX = `${DATA_PREFIXES.staged}permits/census/`;
const BBB_BUSINESSES_PREFIX = `${DATA_PREFIXES.staged}bbb/businesses/`;
const BBB_RATINGS_PREFIX = `${DATA_PREFIXES.staged}bbb/contractor-ratings/`;

/**
 * How many peer objects are fetched at once.
 *
 * The permit census is 231 objects and growing as the history backfill lands, so this is no
 * longer the handful of fixtures it was when the join was first measured. Sequential reads
 * would put minutes of pure latency in front of a 50-second extract; eight at a time keeps
 * it to seconds without opening enough sockets to matter.
 */
const PEER_FETCH_CONCURRENCY = 8;

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let index = next++; index < items.length; index = next++) {
      results[index] = await fn(items[index] as T);
    }
  });
  await Promise.all(workers);
  return results;
}

function parseNdjson<T>(text: string): T[] {
  const records: T[] = [];
  for (const line of text.split('\n')) {
    if (line.trim().length > 0) records.push(JSON.parse(line) as T);
  }
  return records;
}

async function readAll<T>(reader: PeerReader, keys: readonly string[]): Promise<T[]> {
  const chunks = await mapWithConcurrency(keys, PEER_FETCH_CONCURRENCY, async (key) =>
    parseNdjson<T>(await reader.readText(key)),
  );
  return chunks.flat();
}

/**
 * A reader over one or more local directories, checked in order with the first hit winning.
 *
 * The list exists because the peer tiers each mirror the bucket layout under their own
 * scratch directory, and one of them nests it a level deeper. Guessing wrong is what makes a
 * local join silently report zero, so every candidate is tried and the one that answered is
 * named in the summary.
 */
export class LocalPeerReader implements PeerReader {
  readonly description: string;

  constructor(private readonly roots: readonly string[]) {
    this.description = roots.map((root) => resolve(root)).join(', ');
  }

  /** Returns absolute paths, which `readText` then treats as the key. */
  async listNdjson(prefix: string): Promise<string[]> {
    for (const root of this.roots) {
      const found = await walkNdjson(join(root, ...prefix.split('/').filter(Boolean)));
      if (found.length > 0) return found.sort();
    }
    return [];
  }

  async readText(key: string): Promise<string> {
    return readFileSync(key, 'utf8');
  }
}

async function walkNdjson(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return [];
    throw error;
  }
  const found: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await walkNdjson(path)));
    else if (entry.name.endsWith('.ndjson')) found.push(path);
  }
  return found;
}

/** Where a peer tier's local output might be. Checked in order, first hit wins. */
export function localPeerRoots(outputDir: string): string[] {
  return [
    outputDir,
    process.env.PLACES_PEER_DIR ?? '',
    // The BBB tier nests its staged tree under an `out/` directory, so the bare work
    // directory does not contain `staged/` and would silently miss.
    '.bbb-work/out',
    '.bbb-work',
    '.permit-work/out',
    '.permit-work',
    '.publish-work',
  ].filter((root) => root.length > 0);
}

export interface PermitContractors {
  contractors: PermitContractorName[];
  source: string;
}

/**
 * Distinct roofing-relevant contractor names from the staged permit census.
 *
 * Counted rather than listed, because the census carries one row per permit and the same
 * contractor appears on hundreds of them. The count travels onto the match so a consumer can
 * see whether a name is a busy roofer or a single job.
 */
export async function loadPermitContractors(reader: PeerReader): Promise<PermitContractors> {
  const keys = await reader.listNdjson(PERMIT_CENSUS_PREFIX);

  if (keys.length > 0) {
    const rows = await readAll<{ contractorName?: unknown; roofingRelevant?: unknown }>(
      reader,
      keys,
    );
    const counts = new Map<string, number>();
    for (const row of rows) {
      if (row.roofingRelevant !== true) continue;
      const name = typeof row.contractorName === 'string' ? row.contractorName.trim() : '';
      if (name.length < 3) continue;
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    if (counts.size > 0) {
      return {
        contractors: [...counts]
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .map(([name, permitCount]) => ({ name, permitCount })),
        source:
          `staged permit census (${keys.length} shards, ${counts.size} distinct roofing ` +
          `contractors) from ${reader.description}`,
      };
    }
  }

  const override = process.env.PLACES_PERMIT_CONTRACTORS;
  if (override && existsSync(override)) {
    const parsed = JSON.parse(readFileSync(override, 'utf8')) as PermitContractorName[];
    return { contractors: parsed, source: `PLACES_PERMIT_CONTRACTORS=${resolve(override)}` };
  }

  return { contractors: [], source: `none available under ${reader.description}` };
}

export interface BbbPeerOutput {
  businesses: BbbBusinessRecord[];
  ratings: ContractorRatingMatch[];
  source: string;
}

/**
 * The BBB tier's harvested businesses and its own permit-contractor join.
 *
 * Both are read, not one: a direct name match against a harvested business and a rating
 * reached through the permit contractor are different paths with different confidence, and
 * the join publishes which one it took.
 */
export async function loadBbb(reader: PeerReader): Promise<BbbPeerOutput> {
  const [businessKeys, ratingKeys] = await Promise.all([
    reader.listNdjson(BBB_BUSINESSES_PREFIX),
    reader.listNdjson(BBB_RATINGS_PREFIX),
  ]);

  if (businessKeys.length === 0 && ratingKeys.length === 0) {
    return {
      businesses: [],
      ratings: [],
      source: `none available under ${reader.description} — BBB harvest output not present`,
    };
  }

  const [businesses, ratings] = await Promise.all([
    readAll<BbbBusinessRecord>(reader, businessKeys),
    readAll<ContractorRatingMatch>(reader, ratingKeys),
  ]);

  return {
    businesses,
    ratings,
    source:
      `staged BBB output (${businessKeys.length} business shards, ${ratingKeys.length} rating ` +
      `shards) from ${reader.description}`,
  };
}
