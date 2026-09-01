import { createReadStream, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { OPEN_DATA_MAX_BYTES } from './config';
import { queryRow, runSql } from './duckdb';

/**
 * Builds the three dataset directories that become the published IPFS root.
 *
 * Two rules govern the layout and neither is cosmetic.
 *
 * **Every dataset directory holds at least two entries.** `ipfs-car pack --no-wrap`
 * descends past a single-child directory, so packing a `query-table/` that contained
 * only `seminole.parquet` yields a *raw file* CID, not a directory, and every
 * `/<root>/query-table/seminole.parquet` request 404s. A `manifest.json` beside the data
 * is the cheapest guard against that and is worth having regardless.
 *
 * **The build is deterministic.** Same input snapshot, byte-identical output, therefore
 * the same CID — which is what lets the publish step recognise "nothing changed" and
 * decline to spend the upload quota. Determinism comes from single-threaded DuckDB plus
 * an explicit total ordering on every artifact.
 */

export interface DatasetProvenance {
  runId: string;
  county: string;
  publishedAt: string;
  snapshotPrefix: string;
  parcelCount: number;
  sourceFingerprint: string | null;
  snapshotYear: number | null;
}

export interface DatasetSummary {
  /** Byte size of the dataset directory as packed. */
  bytes: number;
  /** File count, for the report. */
  files: number;
  /** `full` or a plain-language description of what was left out. */
  coverage: string;
  /** The one path a consumer is expected to fetch. */
  entryPath: string;
  /** Anything the report should surface, per dataset. */
  notes: Record<string, string | number>;
}

/**
 * Columns published in the geo index, as a compact positional array per property.
 *
 * Positional rather than per-feature objects because the map UI fetches the whole file:
 * repeating seven keys 181,218 times costs about 24 MB of the 5 GB monthly egress
 * allowance for no information. The key names live once, here and in the manifest.
 */
const GEO_COLUMNS = [
  'parcelId',
  'lat',
  'lon',
  'roofAge',
  'yearBuilt',
  'justValue',
  'ownerOutOfArea',
] as const;

interface GeoIndexPayload {
  count: number;
  bbox: [number, number, number, number];
  features: unknown[];
}

interface ShardRow {
  geohash5: string;
  parcels: number;
  /** Raw `to_json` bytes of the shard's rows, before the provenance envelope. */
  bytes: number;
}

/**
 * The provenance envelope wrapped around every property row, as a byte multiplier.
 *
 * ~250 bytes of schema, county, run id and source fingerprint on a ~1,617-byte row. Used
 * only to project a shard's published size when deciding what fits in the budget; the
 * figures reported afterwards are measured, not projected.
 */
const ENVELOPE_OVERHEAD = 1.2;

/**
 * Take whole shards, densest first, while they fit the byte budget.
 *
 * Whole shards rather than a row limit so the slice is a set of complete `geohash5` cells:
 * a radius query inside the slice returns every property that is really there, so it
 * behaves exactly as it will at full scale. A row cap would instead return partially
 * populated neighbourhoods, which looks like data loss and is worse than an honest gap.
 *
 * Densest first because the dense cells are the built-up ones, which is where aged roofs
 * and roofing permits are.
 */
export function selectShards(
  shards: ShardRow[],
  budgetBytes = OPEN_DATA_MAX_BYTES,
): { selected: ShardRow[]; omitted: ShardRow[] } {
  const selected: ShardRow[] = [];
  const omitted: ShardRow[] = [];
  let remaining = budgetBytes;

  for (const shard of shards) {
    const projected = shard.bytes * ENVELOPE_OVERHEAD;
    if (projected <= remaining) {
      selected.push(shard);
      remaining -= projected;
    } else {
      omitted.push(shard);
    }
  }

  return { selected, omitted };
}

/** A DuckDB view over the downloaded snapshot, reused by every builder. */
function snapshotView(snapshotDir: string): string {
  const glob = join(snapshotDir, '**', '*.parquet').replace(/'/g, "''");
  return `CREATE VIEW p AS SELECT * FROM read_parquet('${glob}', hive_partitioning = true);\n`;
}

function sqlString(value: string | number | null): string {
  if (value === null) return 'NULL';
  if (typeof value === 'number') return String(value);
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Manifests are indented because a person reads them; data files are not.
 *
 * Indenting the geo index doubled it from 11 MiB to 21 MiB and the property documents
 * from 120 MiB to 236 MiB — pure whitespace, charged against a 5 GB egress allowance,
 * for files nothing but a program ever opens.
 */
function writeJson(path: string, value: unknown, indent = 0): number {
  const body = `${JSON.stringify(value, null, indent)}\n`;
  writeFileSync(path, body);
  return Buffer.byteLength(body);
}

function writeManifest(path: string, value: unknown): number {
  return writeJson(path, value, 2);
}

/**
 * `query-table/` — one consolidated Parquet, all 181,218 properties.
 *
 * Consolidated rather than a copy of the 56 `geohash5=` objects because the consumer is
 * `read_parquet('https://…/query-table/seminole.parquet')`. HTTP has no directory
 * listing, so DuckDB cannot glob a partitioned tree over a gateway — a published
 * partition layout would be unqueryable dead weight. Partition pruning is replaced by
 * row-group pruning: the file is sorted by `geohash5` and written in 20,000-row groups,
 * so a radius query still reads a fraction of the file over range requests.
 *
 * ZSTD rather than the source's Snappy: 22.0 MB against 40.7 MB, and the file is fetched
 * over a public gateway against a 5 GB monthly egress allowance.
 */
export function buildQueryTable(
  snapshotDir: string,
  outDir: string,
  provenance: DatasetProvenance,
): DatasetSummary {
  mkdirSync(outDir, { recursive: true });
  const parquetPath = join(outDir, 'seminole.parquet');
  rmSync(parquetPath, { force: true });

  runSql(
    snapshotView(snapshotDir) +
      `COPY (SELECT * FROM p ORDER BY geohash5, parcel_id)
       TO '${parquetPath.replace(/'/g, "''")}'
       (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 20000);`,
  );

  const stats = queryRow<{
    rows: number;
    columns: number;
    with_roof_age: number;
    roofs_over_15: number;
    with_coordinates: number;
  }>(
    `SELECT count(*)::BIGINT AS rows,
            (SELECT count(*)::BIGINT FROM (DESCRIBE SELECT * FROM '${parquetPath.replace(/'/g, "''")}')) AS columns,
            count(roof_age)::BIGINT AS with_roof_age,
            count_if(roof_age > 15)::BIGINT AS roofs_over_15,
            count_if(latitude IS NOT NULL AND longitude IS NOT NULL)::BIGINT AS with_coordinates
     FROM '${parquetPath.replace(/'/g, "''")}';`,
  );

  if (stats.rows !== provenance.parcelCount) {
    throw new Error(
      `query table holds ${stats.rows} rows but the publish pointer declares ${provenance.parcelCount}`,
    );
  }

  const parquetBytes = statSync(parquetPath).size;
  const manifestBytes = writeManifest(join(outDir, 'manifest.json'), {
    schema: 'oracle/query-table/1',
    dataset: 'query-table',
    county: provenance.county,
    runId: provenance.runId,
    publishedAt: provenance.publishedAt,
    file: 'seminole.parquet',
    format: 'parquet',
    compression: 'zstd',
    rowGroupSize: 20_000,
    sortedBy: ['geohash5', 'parcel_id'],
    rows: stats.rows,
    columns: stats.columns,
    bytes: parquetBytes,
    coverage: 'full — every property in the published snapshot',
    rowsWithRoofAge: stats.with_roof_age,
    rowsWithCoordinates: stats.with_coordinates,
    roofsOlderThan15Years: stats.roofs_over_15,
    provenance: {
      snapshotPrefix: provenance.snapshotPrefix,
      sourceFingerprint: provenance.sourceFingerprint,
      snapshotYear: provenance.snapshotYear,
    },
    usage: {
      duckdb:
        "SELECT count(*) FROM read_parquet('https://ipfs.io/ipns/<ipns-name>/query-table/seminole.parquet') WHERE roof_age > 15;",
    },
  });

  return {
    bytes: parquetBytes + manifestBytes,
    files: 2,
    coverage: 'full',
    entryPath: 'query-table/seminole.parquet',
    notes: {
      rows: stats.rows,
      columns: stats.columns,
      roofsOlderThan15Years: stats.roofs_over_15,
      parquetBytes,
    },
  };
}

/**
 * `geo-index/` — every property's coordinate, roof age and value, in one small file.
 *
 * The map UI needs the whole county at once to draw pins and cannot issue 181,218
 * requests to do it, so this is the one artifact that is deliberately a single blob
 * rather than something addressable per property. 11.1 MB for full coverage.
 */
export function buildGeoIndex(
  snapshotDir: string,
  outDir: string,
  provenance: DatasetProvenance,
): DatasetSummary {
  mkdirSync(outDir, { recursive: true });

  const { payload } = queryRow<{ payload: GeoIndexPayload }>(
    snapshotView(snapshotDir) +
      `WITH f AS (
         SELECT parcel_id,
                round(latitude, 5) AS lat,
                round(longitude, 5) AS lon,
                json_array(parcel_id, round(latitude, 5), round(longitude, 5), roof_age,
                           year_built, total_just_value::BIGINT, owner_out_of_area) AS r
         FROM p
         WHERE latitude IS NOT NULL AND longitude IS NOT NULL
       )
       SELECT json_object(
         'count', count(*),
         'bbox', json_array(min(lon), min(lat), max(lon), max(lat)),
         'features', to_json(list(r ORDER BY parcel_id))
       ) AS payload
       FROM f;`,
  );

  const geoBytes = writeJson(join(outDir, 'geo.json'), {
    schema: 'oracle/geo-index/1',
    county: provenance.county,
    runId: provenance.runId,
    publishedAt: provenance.publishedAt,
    columns: GEO_COLUMNS,
    count: payload.count,
    bbox: payload.bbox,
    features: payload.features,
  });

  const manifestBytes = writeManifest(join(outDir, 'manifest.json'), {
    schema: 'oracle/geo-index/1',
    dataset: 'geo-index',
    county: provenance.county,
    runId: provenance.runId,
    publishedAt: provenance.publishedAt,
    file: 'geo.json',
    columns: GEO_COLUMNS,
    count: payload.count,
    bbox: payload.bbox,
    bytes: geoBytes,
    coverage: 'full — every property in the published snapshot that carries coordinates',
    // Not equal to the property count when a parcel has no geometry; stated rather
    // than silently absorbed, because it is the denominator of every radius query.
    propertiesInSnapshot: provenance.parcelCount,
    provenance: { snapshotPrefix: provenance.snapshotPrefix },
  });

  return {
    bytes: geoBytes + manifestBytes,
    files: 2,
    coverage: payload.count === provenance.parcelCount ? 'full' : 'full (coordinate-bearing rows)',
    entryPath: 'geo-index/geo.json',
    notes: { features: payload.count, bbox: payload.bbox.join(','), geoBytes },
  };
}

/**
 * `open-data/` — one addressable JSON document per property, Elephant style.
 *
 * This is the artifact that gives each property its *own* CID: a gateway directory
 * listing exposes every child's CID, so a consumer can cite `open-data/shards/<geohash5>/
 * <parcel>.json` and pin exactly that document. It is also a second encoding of data
 * already published whole in `query-table/`, which is what makes bounding it acceptable.
 *
 * It is bounded by `geohash5` shard, densest first, so the slice is a contiguous set of
 * complete neighbourhoods rather than a random sample — a radius demo inside the slice
 * behaves exactly as it would at full scale. The shards left out are named in
 * `index.json` with their parcel counts, so the omission is visible to a consumer rather
 * than looking like missing data.
 */
export async function buildOpenData(
  snapshotDir: string,
  outDir: string,
  provenance: DatasetProvenance,
): Promise<DatasetSummary> {
  mkdirSync(join(outDir, 'shards'), { recursive: true });

  const view = snapshotView(snapshotDir);
  const { payload: shardStats } = queryRow<{
    payload: { shards: ShardRow[]; documentBytes: number };
  }>(
    view +
      `WITH s AS (
         SELECT geohash5, count(*) AS parcels, sum(length(to_json(p)))::BIGINT AS bytes
         FROM p GROUP BY geohash5
       )
       SELECT json_object(
         'shards', to_json(list({'geohash5': geohash5, 'parcels': parcels, 'bytes': bytes}
                                ORDER BY parcels DESC, geohash5)),
         'documentBytes', (SELECT sum(bytes)::BIGINT FROM s)
       ) AS payload
       FROM s;`,
  );

  const { selected, omitted } = selectShards(shardStats.shards);
  const selectedList = selected.map((shard) => sqlString(shard.geohash5)).join(', ');

  const rowsPath = join(outDir, 'rows.ndjson');
  rmSync(rowsPath, { force: true });
  runSql(
    view +
      `COPY (SELECT * FROM p WHERE geohash5 IN (${selectedList}) ORDER BY geohash5, parcel_id)
       TO '${rowsPath.replace(/'/g, "''")}' (FORMAT json, ARRAY false);`,
  );

  const written = await writeDocuments(rowsPath, outDir, provenance);
  rmSync(rowsPath, { force: true });

  const indexBytes = writeManifest(join(outDir, 'index.json'), {
    schema: 'oracle/open-data/1',
    county: provenance.county,
    runId: provenance.runId,
    publishedAt: provenance.publishedAt,
    documentPath: 'shards/{geohash5}/{parcelId}.json',
    documents: written.documents,
    shards: selected,
    coverage: {
      kind: omitted.length === 0 ? 'full' : 'bounded',
      publishedShards: selected.length,
      publishedDocuments: written.documents,
      totalShards: shardStats.shards.length,
      totalDocuments: provenance.parcelCount,
      omittedShards: omitted,
      fullScaleBytes: shardStats.documentBytes,
      reason:
        omitted.length === 0
          ? null
          : `Bounded by OPEN_DATA_MAX_BYTES (${OPEN_DATA_MAX_BYTES} bytes) to stay inside the ` +
            "Filebase free plan's 5 GB monthly egress and on the largest CAR import size " +
            'actually verified. Every property in this snapshot is published in full in ' +
            'query-table/seminole.parquet; this index is a per-property re-encoding of it.',
    },
  });

  const manifestBytes = writeManifest(join(outDir, 'manifest.json'), {
    schema: 'oracle/open-data/1',
    dataset: 'open-data',
    county: provenance.county,
    runId: provenance.runId,
    publishedAt: provenance.publishedAt,
    index: 'index.json',
    documents: written.documents,
    bytes: written.bytes,
    provenance: {
      snapshotPrefix: provenance.snapshotPrefix,
      sourceFingerprint: provenance.sourceFingerprint,
      snapshotYear: provenance.snapshotYear,
    },
  });

  return {
    bytes: written.bytes + indexBytes + manifestBytes,
    files: written.documents + 2,
    coverage:
      omitted.length === 0
        ? 'full'
        : `${written.documents} of ${provenance.parcelCount} documents ` +
          `(${selected.length} of ${shardStats.shards.length} geohash5 shards, complete shards only)`,
    entryPath: 'open-data/index.json',
    notes: {
      documents: written.documents,
      publishedShards: selected.length,
      totalShards: shardStats.shards.length,
      fullScaleBytes: shardStats.documentBytes,
    },
  };
}

interface PropertyRow {
  parcel_id: string;
  geohash5: string;
  [column: string]: unknown;
}

/**
 * Split the NDJSON dump into one document per property.
 *
 * Streamed line by line rather than read whole: the full-scale dump is ~293 MB, and a
 * publisher that only works below its own heap limit is a publisher that fails the first
 * time the shard limit is raised.
 */
async function writeDocuments(
  rowsPath: string,
  outDir: string,
  provenance: DatasetProvenance,
): Promise<{ documents: number; bytes: number }> {
  const shardDirs = new Set<string>();
  let documents = 0;
  let bytes = 0;

  const lines = createInterface({ input: createReadStream(rowsPath), crlfDelay: Infinity });
  for await (const line of lines) {
    if (line.length === 0) continue;
    const row = JSON.parse(line) as PropertyRow;
    const shardDir = join(outDir, 'shards', row.geohash5);
    if (!shardDirs.has(shardDir)) {
      mkdirSync(shardDir, { recursive: true });
      shardDirs.add(shardDir);
    }
    bytes += writeJson(join(shardDir, `${row.parcel_id}.json`), {
      schema: 'oracle/property/1',
      county: provenance.county,
      parcelId: row.parcel_id,
      runId: provenance.runId,
      publishedAt: provenance.publishedAt,
      provenance: {
        snapshotPrefix: provenance.snapshotPrefix,
        sourceFingerprint: provenance.sourceFingerprint,
        snapshotYear: provenance.snapshotYear,
      },
      property: row,
    });
    documents += 1;
  }

  return { documents, bytes };
}
