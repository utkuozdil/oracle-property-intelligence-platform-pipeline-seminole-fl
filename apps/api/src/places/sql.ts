/**
 * The SQL this tier runs, assembled here so every predicate is reviewable in one place.
 *
 * Two properties of these statements are load-bearing:
 *
 * **The bounding box is interpolated as literals.** A join against a one-row boundary table
 * would be tidier and would also defeat the point: only a literal comparison reaches the
 * Parquet row-group statistics, and without that the extract reads the entire global places
 * theme instead of the handful of row groups covering central Florida.
 *
 * **The geometric test is a second stage, never a substitute for the first.** `ST_Within`
 * cannot be pushed into Parquet, so it runs over the pruned set. Doing it the other way
 * round is the difference between a 35-second extract and an unusable one.
 */
import {
  COUNTY_BBOX,
  ROOFING_TAXONOMY_PATH,
  UNINCORPORATED,
  overturePlacesGlob,
  overtureSourceUrl,
} from './config';
import { sqlString } from './duckdb';

/**
 * A geohash-5 encoder, because DuckDB's spatial extension has none.
 *
 * Written rather than approximated because `geohash5` is the parcel snapshot's partition
 * key: a business and a parcel on the same street have to land in the same shard or a radius
 * query over both datasets reads the wrong files. The implementation interleaves the binary
 * expansions of longitude and latitude — 13 lon bits and 12 lat bits, longitude first —
 * which is exactly the bisection sequence a geohash encodes, then maps each 5-bit group
 * through the base-32 alphabet.
 *
 * Verified by reproducing the `geohash5` column of all 181,218 rows of the published parcel
 * snapshot with zero disagreements. That test is in `places.test.ts` and is the reason this
 * is trustworthy rather than merely plausible.
 */
export const GEOHASH_MACROS = `
CREATE OR REPLACE MACRO gh_lon_bits(lon) AS
  CAST(floor(least(greatest((lon + 180.0) / 360.0, 0.0), 0.9999999999) * 8192) AS BIGINT);
CREATE OR REPLACE MACRO gh_lat_bits(lat) AS
  CAST(floor(least(greatest((lat + 90.0) / 180.0, 0.0), 0.9999999999) * 4096) AS BIGINT);
CREATE OR REPLACE MACRO gh_code(lon, lat) AS
  list_sum(list_transform(range(0, 13),
    lambda i: ((gh_lon_bits(lon) >> (12 - i)) & 1) << (24 - 2 * i)))
  + list_sum(list_transform(range(0, 12),
    lambda i: ((gh_lat_bits(lat) >> (11 - i)) & 1) << (23 - 2 * i)));
CREATE OR REPLACE MACRO geohash5(lon, lat) AS
  list_reduce(
    list_transform(range(0, 5), lambda k: substr(
      '0123456789bcdefghjkmnpqrstuvwxyz',
      CAST(((gh_code(lon, lat) >> (20 - 5 * k)) & 31) + 1 AS BIGINT), 1)),
    lambda a, b: a || b
  );

CREATE OR REPLACE MACRO confidence_band(c) AS CASE
  WHEN c IS NULL       THEN 'unknown'
  WHEN c < 0.5         THEN '<0.50'
  WHEN c < 0.6         THEN '0.50-0.60'
  WHEN c < 0.7         THEN '0.60-0.70'
  WHEN c < 0.8         THEN '0.70-0.80'
  WHEN c < 0.9         THEN '0.80-0.90'
  WHEN c < 0.95        THEN '0.90-0.95'
  ELSE '>=0.95' END;
`;

/**
 * Loads both boundary layers.
 *
 * `ST_Read` labels a GeoJSON file `EPSG:4326` while Overture geometries carry `OGC:CRS84`.
 * The two differ only in nominal axis order and the file is already lon/lat, so `ST_SetCRS`
 * relabels without transforming. `ST_Transform` here would be wrong: it would attempt a
 * real coordinate conversion between two names for the same thing.
 */
export function boundaryTables(countyPath: string, municipalPath: string): string {
  return `
CREATE OR REPLACE TABLE county AS
SELECT ST_SetCRS(geom, 'OGC:CRS84') AS geometry, GEOID AS geoid, NAME AS name
FROM ST_Read(${sqlString(countyPath)});

CREATE OR REPLACE TABLE municipality AS
SELECT ST_SetCRS(geom, 'OGC:CRS84') AS geometry, GEOID AS geoid, BASENAME AS name
FROM ST_Read(${sqlString(municipalPath)});
`;
}

/**
 * Stage 1 then stage 2, for one release.
 *
 * Table names are suffixed so a diff run can hold two releases in one session and compare
 * them without a second network scan.
 */
export function clipRelease(release: string, suffix = ''): string {
  const pruned = `bbox_pruned${suffix}`;
  const clipped = `clipped${suffix}`;
  return `
CREATE OR REPLACE TABLE ${pruned} AS
SELECT * FROM read_parquet(${sqlString(overturePlacesGlob(release))})
WHERE bbox.xmin BETWEEN ${COUNTY_BBOX.xmin} AND ${COUNTY_BBOX.xmax}
  AND bbox.ymin BETWEEN ${COUNTY_BBOX.ymin} AND ${COUNTY_BBOX.ymax};

CREATE OR REPLACE TABLE ${clipped} AS
SELECT p.* FROM ${pruned} p, county c WHERE ST_Within(p.geometry, c.geometry);
`;
}

/**
 * Flattens the clipped places into the published row shape.
 *
 * Jurisdiction is a `LEFT JOIN` against the municipal polygons, so a business outside every
 * city polygon becomes unincorporated rather than dropping out of the result. The address
 * locality is kept beside it and compared, never used to decide: postal city names cross
 * county lines, which is precisely why a bbox ingest looked plausible and was wrong.
 */
export function businessLocations(options: {
  release: string;
  fetchedAt: string;
  suffix?: string;
}): string {
  const suffix = options.suffix ?? '';
  const seminoleLocalities = `[
    'ALTAMONTE SPRINGS', 'CASSELBERRY', 'LAKE MARY', 'LONGWOOD', 'OVIEDO', 'SANFORD',
    'WINTER SPRINGS', 'GENEVA', 'CHULUOTA', 'FERN PARK', 'HEATHROW', 'FOREST CITY',
    'LAKE MONROE', 'MIDWAY', 'SLAVIA', 'ALTAMONTE SPG', 'WINTER SPGS'
  ]`;

  return `
CREATE OR REPLACE TABLE business_locations${suffix} AS
SELECT
  c.id                                              AS gers_id,
  c.names.primary                                   AS name,
  c.taxonomy.primary                                AS taxonomy_primary,
  array_to_string(c.taxonomy.hierarchy, '/')         AS taxonomy_hierarchy,
  coalesce(c.taxonomy.alternates, [])               AS taxonomy_alternates,
  c.basic_category                                  AS basic_category,
  c.categories.primary                              AS legacy_category_primary,
  c.confidence                                      AS confidence,
  confidence_band(c.confidence)                     AS confidence_band,
  ST_Y(c.geometry)                                  AS latitude,
  ST_X(c.geometry)                                  AS longitude,
  geohash5(ST_X(c.geometry), ST_Y(c.geometry))      AS geohash5,
  coalesce(m.name, ${sqlString(UNINCORPORATED)})     AS jurisdiction,
  m.geoid                                           AS jurisdiction_geoid,
  c.addresses[1].freeform                           AS address_freeform,
  c.addresses[1].locality                           AS address_locality,
  c.addresses[1].postcode                           AS address_postcode,
  c.addresses[1].region                             AS address_region,
  (c.addresses[1].locality IS NOT NULL
     AND list_contains(${seminoleLocalities}, upper(trim(c.addresses[1].locality))))
                                                    AS locality_matches_jurisdiction,
  c.operating_status                                AS operating_status,
  coalesce(c.websites, [])                          AS websites,
  coalesce(c.phones, [])                            AS phones,
  coalesce(c.emails, [])                            AS emails,
  coalesce(c.socials, [])                           AS socials,
  c.brand.names.primary                             AS brand_name,
  list_distinct(list_transform(c.sources, lambda s: s.dataset))  AS source_datasets,
  list_distinct(list_transform(c.sources, lambda s: s.license))  AS source_licenses,
  ${sqlString(options.release)}                      AS overture_release,
  ${sqlString(overtureSourceUrl(options.release))}   AS source_url,
  ${sqlString(options.fetchedAt)}                    AS fetched_at
FROM clipped${suffix} c
LEFT JOIN municipality m ON ST_Within(c.geometry, m.geometry);
`;
}

/**
 * Distinct provider lineage, for the licence gate.
 *
 * Returns the source's own spelling alongside a lowercased comparison key. Lowercasing only
 * for comparison is deliberate: the published NOTICE has to name providers the way they
 * write their own names.
 */
export function sourceGateQuery(suffix = ''): string {
  return `
SELECT s.dataset AS dataset,
       lower(s.dataset) AS dataset_key,
       any_value(s.license) AS license,
       count(DISTINCT c.id) AS places
FROM clipped${suffix} c, UNNEST(c.sources) AS t(s)
GROUP BY 1, 2
ORDER BY places DESC;
`;
}

/** Every count the run summary reports, in one pass over the flattened table. */
export function summaryQuery(suffix = ''): string {
  return `
SELECT
  (SELECT count(*) FROM bbox_pruned${suffix})                             AS bbox_pruned_count,
  (SELECT count(*) FROM clipped${suffix})                                 AS clipped_count,
  count(*)                                                                AS rows,
  count(DISTINCT gers_id)                                                 AS distinct_gers_ids,
  count(*) FILTER (WHERE latitude IS NULL OR longitude IS NULL)            AS null_geometry_count,
  count(*) FILTER (WHERE taxonomy_hierarchy = ${sqlString(ROOFING_TAXONOMY_PATH)}) AS roofing_count,
  count(DISTINCT CASE WHEN taxonomy_hierarchy = ${sqlString(ROOFING_TAXONOMY_PATH)}
                      THEN upper(trim(name)) END)                         AS roofing_distinct_names,
  count(*) FILTER (WHERE NOT locality_matches_jurisdiction)               AS locality_disagreement_count,
  count(*) FILTER (WHERE confidence < 0.6)                                AS rows_below_recommended_floor,
  min(confidence)                                                         AS confidence_min,
  max(confidence)                                                         AS confidence_max,
  avg(confidence)                                                         AS confidence_mean,
  median(confidence)                                                      AS confidence_median
FROM business_locations${suffix};
`;
}

export function bandQuery(suffix = ''): string {
  return `
SELECT confidence_band AS band, count(*) AS places,
       round(100.0 * count(*) / (SELECT count(*) FROM business_locations${suffix}), 2) AS pct
FROM business_locations${suffix} GROUP BY 1 ORDER BY 1;
`;
}

export function groupCountQuery(column: string, suffix = ''): string {
  return `
SELECT coalesce(CAST(${column} AS VARCHAR), 'unknown') AS key, count(*) AS n
FROM business_locations${suffix} GROUP BY 1 ORDER BY n DESC;
`;
}

/**
 * Release-over-release change, by GERS id.
 *
 * `data_changed` compares the fields a consumer can see change. `version` alone is not
 * enough — Overture bumps it for edits this artifact does not carry — and a full row
 * comparison would report a change every time an unpublished internal field moved.
 */
export function deltaQuery(): string {
  return `
WITH cur AS (SELECT * FROM business_locations),
     prv AS (SELECT * FROM business_locations_prev)
SELECT
  (SELECT count(*) FROM prv)                                          AS from_count,
  (SELECT count(*) FROM cur)                                          AS to_count,
  (SELECT count(*) FROM cur WHERE gers_id NOT IN (SELECT gers_id FROM prv)) AS added,
  (SELECT count(*) FROM prv WHERE gers_id NOT IN (SELECT gers_id FROM cur)) AS removed,
  (SELECT count(*) FROM cur JOIN prv USING (gers_id)
   WHERE coalesce(cur.name, '') <> coalesce(prv.name, '')
      OR coalesce(cur.taxonomy_hierarchy, '') <> coalesce(prv.taxonomy_hierarchy, '')
      OR cur.confidence <> prv.confidence
      OR coalesce(cur.operating_status, '') <> coalesce(prv.operating_status, ''))
                                                                      AS data_changed,
  (SELECT count(*) FROM cur JOIN prv USING (gers_id))                 AS common;
`;
}

/**
 * Adds the cross-release lifecycle columns.
 *
 * Applied after the delta so `first_seen_release` reflects real evidence when a previous
 * release was extracted, and degrades to "first seen in this release" when it was not.
 * Absence from a release is never written as closure — `operating_status` is the only
 * closure signal, and it comes from the source.
 */
export function lifecycleColumns(options: { release: string; hasPrevious: boolean }): string {
  const previousSeen = options.hasPrevious
    ? `CASE WHEN gers_id IN (SELECT gers_id FROM business_locations_prev)
            THEN (SELECT any_value(overture_release) FROM business_locations_prev)
            ELSE ${sqlString(options.release)} END`
    : sqlString(options.release);

  return `
CREATE OR REPLACE TABLE business_locations_final AS
SELECT *,
       ${previousSeen} AS first_seen_release,
       ${sqlString(options.release)} AS last_seen_release,
       true AS is_current
FROM business_locations;
`;
}

/**
 * The two artifacts, written single-threaded and totally ordered so the bytes — and
 * therefore the CID — are reproducible.
 *
 * The consolidated file is what a consumer queries: HTTP has no directory listing, so DuckDB
 * cannot glob a partitioned tree over an IPFS gateway, and a published partition layout
 * would be unqueryable. The partitioned copy exists for the staged tier, where a reader has
 * a real filesystem or an S3 listing.
 */
export function writeArtifacts(options: {
  partitionedDir: string;
  tablePath: string;
  rowGroupSize: number;
}): string {
  return `
COPY (SELECT * FROM business_locations_final ORDER BY jurisdiction, geohash5, gers_id)
  TO ${sqlString(options.partitionedDir)}
  (FORMAT parquet, COMPRESSION zstd, PARTITION_BY (jurisdiction), OVERWRITE_OR_IGNORE true);

COPY (SELECT * FROM business_locations_final ORDER BY jurisdiction, geohash5, gers_id)
  TO ${sqlString(options.tablePath)}
  (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE ${options.rowGroupSize});
`;
}

/**
 * A hash over the data, excluding the per-row fetch timestamp.
 *
 * The brief requires `fetched_at` on every record, and that requirement is at odds with
 * byte-identical output: two runs an hour apart over an unchanged release differ in every
 * row, so the Parquet bytes differ, so the CID differs, and a publish step that decides
 * "nothing changed" by comparing bytes would re-upload the whole artifact nightly.
 *
 * So the timestamp stays on the row and change detection moves to this fingerprint. It is
 * computed over the ordered content a consumer can actually observe, which is what "the
 * data is unchanged" means. The row ordering is the same total order the artifact is written
 * in, so the hash is stable across runs rather than across threads.
 */
export function contentFingerprintQuery(): string {
  return `
SELECT md5(string_agg(row_text, '\n' ORDER BY jurisdiction, geohash5, gers_id)) AS fingerprint
FROM (
  SELECT jurisdiction, geohash5, gers_id,
         concat_ws('\u001f', gers_id, coalesce(name, ''), coalesce(taxonomy_hierarchy, ''),
                   CAST(confidence AS VARCHAR), CAST(latitude AS VARCHAR),
                   CAST(longitude AS VARCHAR), jurisdiction,
                   coalesce(operating_status, ''), coalesce(address_freeform, ''),
                   array_to_string(source_datasets, ',')) AS row_text
  FROM business_locations_final
);
`;
}

/** The roofing rows the join needs, small enough to hand to TypeScript as JSON. */
export function roofingRowsQuery(): string {
  return `
SELECT gers_id, name, jurisdiction, confidence, address_freeform, websites, phones
FROM business_locations_final
WHERE taxonomy_hierarchy = ${sqlString(ROOFING_TAXONOMY_PATH)}
ORDER BY confidence DESC, gers_id;
`;
}
