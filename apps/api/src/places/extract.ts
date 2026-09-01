/**
 * The ingest run: resolve a boundary, clip a release to it, gate its licences, and write the
 * artifacts.
 *
 * The whole run is a DuckDB session against public data. That is not a shortcut — it is the
 * cost argument this milestone has to make. There is no database to keep warm, no cluster,
 * no credentials, and nothing running between runs; a refresh is a few minutes of one
 * process, and the published artifact is a file on IPFS that Oracle does not host.
 */
import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  APPROVED_SOURCE_DATASETS,
  COUNTY_FIPS,
  COUNTY_NAME,
  FORBIDDEN_SOURCE_DATASETS,
  OVERTURE_RELEASE,
  PUBLISH_ROW_GROUP_SIZE,
  RECOMMENDED_CONFIDENCE_FLOOR,
} from './config';
import { fetchCountyBoundary, fetchMunicipalBoundaries } from './boundary';
import { query, queryRow, runSql } from './duckdb';
import {
  assertSummary,
  type ConfidenceBandCount,
  type PlacesIngestRequest,
  type PlacesRunSummary,
  type ReleaseDelta,
  type SourceGateResult,
} from './model';
import { checkReleaseDrift } from './release';
import {
  GEOHASH_MACROS,
  bandQuery,
  boundaryTables,
  businessLocations,
  clipRelease,
  contentFingerprintQuery,
  deltaQuery,
  groupCountQuery,
  lifecycleColumns,
  roofingRowsQuery,
  sourceGateQuery,
  summaryQuery,
  writeArtifacts,
} from './sql';
import {
  publishedPlacesTableKey,
  rawBoundaryKey,
  resolveOutputDir,
  stagedPlacesPrefix,
  summaryKey,
} from './storage';

export class SourceGateError extends Error {
  override readonly name = 'SourceGateError';
}

interface SummaryRow {
  bbox_pruned_count: number;
  clipped_count: number;
  rows: number;
  distinct_gers_ids: number;
  null_geometry_count: number;
  roofing_count: number;
  roofing_distinct_names: number;
  locality_disagreement_count: number;
  rows_below_recommended_floor: number;
  confidence_min: number;
  confidence_max: number;
  confidence_mean: number;
  confidence_median: number;
}

interface GateRow {
  dataset: string;
  dataset_key: string;
  license: string;
  places: number;
}

interface DeltaRow {
  from_count: number;
  to_count: number;
  added: number;
  removed: number;
  data_changed: number;
  common: number;
}

export interface RoofingRow {
  gers_id: string;
  name: string | null;
  jurisdiction: string;
  confidence: number;
  address_freeform: string | null;
  websites: string[];
  phones: string[];
}

export interface ExtractResult {
  summary: PlacesRunSummary;
  roofingRows: RoofingRow[];
  /** The DuckDB file the run left behind, so the demo query can reuse it. */
  databasePath: string;
  outputDir: string;
}

/**
 * The licence gate. Fails closed, and is deliberately not clever.
 *
 * An unrecognised provider is a stop, not a warning, because the published `NOTICE.txt` is
 * only valid for the providers it names — shipping an artifact whose lineage includes
 * something the notice does not cover is a licence problem, and no row count is worth one.
 * The allowlist is never extended from observed data.
 */
export function evaluateSourceGate(rows: readonly GateRow[]): SourceGateResult {
  const forbidden: string[] = [];
  const unknown: string[] = [];

  for (const row of rows) {
    const key = row.dataset_key.toLowerCase();
    if (FORBIDDEN_SOURCE_DATASETS.has(key)) {
      forbidden.push(key);
      continue;
    }
    if (!APPROVED_SOURCE_DATASETS.has(key)) unknown.push(key);
  }

  return {
    datasets: rows.map((row) => ({
      dataset: row.dataset,
      license: row.license,
      places: Number(row.places),
    })),
    unknown: [...new Set(unknown)].sort(),
    forbidden: [...new Set(forbidden)].sort(),
    passed: forbidden.length === 0 && unknown.length === 0,
  };
}

function toCounts(rows: readonly { key: string; n: number }[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.key] = Number(row.n);
  return counts;
}

export async function runIngest(request: PlacesIngestRequest = {}): Promise<ExtractResult> {
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const release = request.release ?? OVERTURE_RELEASE;
  const runId = `places-${release}-${startedAt.replace(/[:.]/g, '').slice(0, 15)}`;
  const warnings: string[] = [];

  const outputDir = resolveOutputDir(request.outputDir);
  mkdirSync(outputDir, { recursive: true });

  const drift = await checkReleaseDrift(release);
  if (drift.warning) warnings.push(drift.warning);
  if (drift.drifted && request.failOnReleaseDrift === true) {
    throw new Error(drift.warning ?? 'release drift');
  }

  const county = await fetchCountyBoundary(COUNTY_FIPS);
  const municipalities = await fetchMunicipalBoundaries(county.provenance.bbox);

  /**
   * The boundary bytes are written before anything is computed from them. A count whose
   * boundary was never persisted cannot be reproduced, and "the border moved" is otherwise
   * indistinguishable from "the data changed".
   */
  const countyPath = join(
    outputDir,
    rawBoundaryKey({
      layer: 'county',
      vintage: county.provenance.vintage,
      fingerprint: county.provenance.fingerprint,
    }),
  );
  const municipalPath = join(
    outputDir,
    rawBoundaryKey({
      layer: 'places',
      vintage: county.provenance.vintage,
      fingerprint: municipalities.fingerprint,
    }),
  );
  for (const [path, body] of [
    [countyPath, county.geojson],
    [municipalPath, municipalities.geojson],
  ] as const) {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, body);
  }

  const databasePath = join(outputDir, `places-${release}.duckdb`);
  rmSync(databasePath, { force: true });
  const db = { database: databasePath };

  runSql(GEOHASH_MACROS + boundaryTables(countyPath, municipalPath), db);
  runSql(clipRelease(release), db);
  runSql(businessLocations({ release, fetchedAt: startedAt }), db);

  const gate = evaluateSourceGate(query<GateRow>(sourceGateQuery(), db));
  if (!gate.passed) {
    throw new SourceGateError(
      `licence gate failed on the clipped extract: forbidden=[${gate.forbidden.join(', ')}] ` +
        `unknown=[${gate.unknown.join(', ')}] — nothing was written`,
    );
  }

  let delta: ReleaseDelta | null = null;
  const diffAgainst = request.diffAgainst;
  if (diffAgainst) {
    if (diffAgainst === release) throw new Error('cannot diff a release against itself');
    runSql(clipRelease(diffAgainst, '_prev'), db);
    runSql(businessLocations({ release: diffAgainst, fetchedAt: startedAt, suffix: '_prev' }), db);
    const row = queryRow<DeltaRow>(deltaQuery(), db);
    delta = {
      fromRelease: diffAgainst,
      toRelease: release,
      fromCount: Number(row.from_count),
      toCount: Number(row.to_count),
      added: Number(row.added),
      removed: Number(row.removed),
      dataChanged: Number(row.data_changed),
      unchanged: Number(row.common) - Number(row.data_changed),
    };
  }

  runSql(lifecycleColumns({ release, hasPrevious: delta !== null }), db);

  const artifacts: { key: string; bytes: number; rows: number }[] = [];
  const stats = queryRow<SummaryRow>(summaryQuery(), db);

  if (request.countsOnly !== true) {
    const partitionedDir = join(outputDir, stagedPlacesPrefix(release));
    const tablePath = join(outputDir, publishedPlacesTableKey(release));
    rmSync(partitionedDir, { recursive: true, force: true });
    mkdirSync(partitionedDir, { recursive: true });
    mkdirSync(join(tablePath, '..'), { recursive: true });

    runSql(
      writeArtifacts({
        partitionedDir,
        tablePath,
        rowGroupSize: PUBLISH_ROW_GROUP_SIZE,
      }),
      { ...db, deterministic: true },
    );

    artifacts.push({
      key: publishedPlacesTableKey(release),
      bytes: statSync(tablePath).size,
      rows: Number(stats.rows),
    });
  } else {
    warnings.push('countsOnly run: no Parquet was written');
  }

  const summary: PlacesRunSummary = {
    runId,
    county: COUNTY_NAME,
    countyFips: COUNTY_FIPS,
    release,
    startedAt,
    finishedAt: new Date().toISOString(),
    elapsedSeconds: Number(((Date.now() - startedMs) / 1000).toFixed(1)),
    boundary: county.provenance,
    bboxPrunedCount: Number(stats.bbox_pruned_count),
    clippedCount: Number(stats.clipped_count),
    bboxOnlyCount: Number(stats.bbox_pruned_count) - Number(stats.clipped_count),
    distinctGersIds: Number(stats.distinct_gers_ids),
    nullGeometryCount: Number(stats.null_geometry_count),
    jurisdictionCounts: toCounts(query(groupCountQuery('jurisdiction'), db)),
    confidenceBands: query<ConfidenceBandCount>(bandQuery(), db).map((band) => ({
      band: band.band,
      places: Number(band.places),
      pct: Number(band.pct),
    })),
    confidence: {
      min: Number(stats.confidence_min),
      median: Number(stats.confidence_median),
      mean: Number(stats.confidence_mean),
      max: Number(stats.confidence_max),
    },
    recommendedConfidenceFloor: RECOMMENDED_CONFIDENCE_FLOOR,
    rowsBelowRecommendedFloor: Number(stats.rows_below_recommended_floor),
    roofingCount: Number(stats.roofing_count),
    roofingDistinctNames: Number(stats.roofing_distinct_names),
    operatingStatusCounts: toCounts(query(groupCountQuery('operating_status'), db)),
    localityDisagreementCount: Number(stats.locality_disagreement_count),
    sourceGate: gate,
    contentFingerprint: queryRow<{ fingerprint: string }>(contentFingerprintQuery(), db)
      .fingerprint,
    delta,
    releaseDrift: { pinned: drift.pinned, latest: drift.latest, drifted: drift.drifted },
    artifacts,
    warnings,
  };

  assertSummary(summary);

  const summaryPath = join(outputDir, summaryKey(runId));
  mkdirSync(join(summaryPath, '..'), { recursive: true });
  writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);

  return {
    summary,
    roofingRows: query<RoofingRow>(roofingRowsQuery(), db),
    databasePath,
    outputDir,
  };
}
