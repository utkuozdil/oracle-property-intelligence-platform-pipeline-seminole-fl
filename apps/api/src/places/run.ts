/**
 * One whole run: extract, join, point at the result, and mirror it to wherever it belongs.
 *
 * Extracted out of the CLI so the scheduled Lambda and the operator command execute the same
 * code rather than two implementations that agree until they do not. The two callers differ
 * in exactly two arguments — where peer output is read from, and whether the finished tree is
 * copied into the data bucket — and in nothing else.
 *
 * The working directory is always local, including in Lambda. DuckDB writes Parquet through
 * the filesystem, and having it write to S3 directly would mean signing requests to the data
 * bucket in the same session that must reach Overture unsigned. Materialising locally and
 * uploading afterwards keeps those two apart, and the keys are identical either way.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { runIngest } from './extract';
import type { PlacesIngestRequest, PlacesRunSummary, RoofingJoinSummary } from './model';
import { loadBbb, loadPermitContractors } from './peers';
import type { ArtifactSink, PeerReader } from './objects';
import { publishArtifacts } from './objects';
import { joinRoofingBusinesses } from './roofing-join';
import {
  currentPointerKey,
  publishedPlacesTableKey,
  resolveOutputDir,
  roofingJoinSummaryKey,
  roofingMatchesKey,
} from './storage';

export interface PlacesRunOptions {
  request?: PlacesIngestRequest;
  /** Where the permit census and BBB harvest output are read from. */
  peers: PeerReader;
  /** Omitted for a local run, which leaves the tree in the working directory. */
  sink?: ArtifactSink;
  /** Wipe the working directory first. Set in Lambda, where `/tmp` survives an invocation. */
  clean?: boolean;
}

export interface PlacesRunResult {
  summary: PlacesRunSummary;
  join: RoofingJoinSummary;
  outputDir: string;
  databasePath: string;
  matchesPath: string;
  /** Objects copied to the sink. Empty for a local run. */
  published: { key: string; bytes: number }[];
  destination: string;
}

/**
 * The stable pointer a consumer follows instead of knowing a release id.
 *
 * Written last, after every artifact is durable, so it never names a partial run.
 */
interface CurrentPointer {
  release: string;
  runId: string;
  publishedAt: string;
  businessLocations: number;
  roofingPlaces: number;
  contentFingerprint: string;
  table: string;
  roofingMatches: string;
}

async function writeUnder(outputDir: string, key: string, body: string): Promise<string> {
  const path = join(outputDir, ...key.split('/'));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, body, 'utf8');
  return path;
}

export async function runPlaces(options: PlacesRunOptions): Promise<PlacesRunResult> {
  const request = options.request ?? {};
  const outputDir = resolveOutputDir(request.outputDir);
  if (options.clean === true) await rm(outputDir, { recursive: true, force: true });

  // Only set in the container image, where DuckDB has to be told somewhere writable to
  // spill to. Created here rather than in the Dockerfile because /tmp is a fresh mount.
  const tempDir = process.env.DUCKDB_TEMP_DIR;
  if (tempDir) await mkdir(tempDir, { recursive: true });

  const ingest = await runIngest({ ...request, outputDir });
  const { summary } = ingest;

  const [permits, bbb] = await Promise.all([
    loadPermitContractors(options.peers),
    loadBbb(options.peers),
  ]);

  const { matches, summary: joinSummary } = joinRoofingBusinesses({
    release: summary.release,
    roofingRows: ingest.roofingRows,
    permitContractors: permits.contractors,
    bbbBusinesses: bbb.businesses,
    contractorRatings: bbb.ratings,
    permitContractorSource: permits.source,
    bbbBusinessSource: bbb.source,
  });

  const matchesPath = await writeUnder(
    outputDir,
    roofingMatchesKey(summary.release),
    `${matches.map((match) => JSON.stringify(match)).join('\n')}\n`,
  );
  await writeUnder(
    outputDir,
    roofingJoinSummaryKey(summary.runId),
    `${JSON.stringify(joinSummary, null, 2)}\n`,
  );

  /**
   * `countsOnly` writes no table, so it must not move the pointer — the previous release
   * would keep being the newest published one and this run would name an artifact that was
   * never written.
   */
  if (request.countsOnly !== true) {
    const pointer: CurrentPointer = {
      release: summary.release,
      runId: summary.runId,
      publishedAt: summary.finishedAt,
      businessLocations: summary.clippedCount,
      roofingPlaces: joinSummary.roofingPlaces,
      contentFingerprint: summary.contentFingerprint,
      table: publishedPlacesTableKey(summary.release),
      roofingMatches: roofingMatchesKey(summary.release),
    };
    await writeUnder(outputDir, currentPointerKey(), `${JSON.stringify(pointer, null, 2)}\n`);
  }

  const published = options.sink ? await publishArtifacts(options.sink, outputDir) : [];

  return {
    summary,
    join: joinSummary,
    outputDir,
    databasePath: ingest.databasePath,
    matchesPath,
    published,
    destination: options.sink?.description ?? outputDir,
  };
}
