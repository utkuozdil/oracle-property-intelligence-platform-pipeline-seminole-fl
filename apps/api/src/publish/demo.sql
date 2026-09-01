-- DuckDB-backed query layer over the IPFS-published Seminole County property table.
--
-- Run it with `just duckdb-demo`, which prepends a `properties` view pointing at the
-- published Parquet and pipes this file into the DuckDB CLI.
--
-- There is no database here. DuckDB is a process that starts, range-reads row groups out
-- of a Parquet file on a public IPFS gateway, answers, and exits. Nothing is provisioned,
-- nothing is running between queries, and nothing bills — which is the infrastructure
-- claim this milestone has to make, demonstrated rather than asserted.

.mode box
.timer on

SELECT '1. Source — where the data actually is' AS step;
SELECT
  count(*)                                    AS properties,
  count(DISTINCT geohash5)                    AS geohash5_cells,
  min(year_built)                             AS oldest_year_built,
  max(last_sale_date)                         AS latest_sale
FROM properties;

SELECT '2. Roofs older than 15 years — the headline roofing-lead question' AS step;
SELECT
  count(*)                                                      AS properties_with_roof_age,
  count_if(roof_age > 15)                                        AS roofs_over_15_years,
  round(100.0 * count_if(roof_age > 15) / count(*), 1)           AS pct_over_15,
  count_if(roof_age > 25)                                        AS roofs_over_25_years,
  round(avg(roof_age), 1)                                        AS mean_roof_age
FROM properties
WHERE roof_age IS NOT NULL;

SELECT '3. Aged-roof concentration by area — where to send a crew' AS step;
SELECT
  coalesce(jurisdiction, 'UNINCORPORATED')                       AS jurisdiction,
  count_if(roof_age > 15)                                        AS aged_roofs,
  round(avg(roof_age) FILTER (roof_age > 15), 1)                 AS mean_aged_roof,
  round(avg(total_just_value) FILTER (roof_age > 15))            AS mean_just_value
FROM properties
GROUP BY 1
HAVING aged_roofs > 250
ORDER BY aged_roofs DESC
LIMIT 10;

SELECT '4. Radius query — aged roofs within 5 miles of downtown Sanford' AS step;
-- Haversine against a fixed pin. The CRM passes a map pin instead of these literals; the
-- shape of the query is the same, which is the point of publishing coordinates per row.
WITH pin AS (SELECT 28.8117 AS lat, -81.2734 AS lon, 5.0 AS radius_miles)
SELECT
  count(*)                                                      AS properties_in_radius,
  count_if(roof_age > 15)                                        AS aged_roofs_in_radius,
  count_if(roof_age > 15 AND owner_out_of_area)                  AS aged_roofs_out_of_area_owner,
  count_if(roof_age > 15 AND years_since_sale > 10)              AS aged_roofs_held_over_10_years
FROM properties, pin
WHERE latitude IS NOT NULL
  AND 3958.8 * 2 * asin(sqrt(
        pow(sin(radians(latitude - pin.lat) / 2), 2) +
        cos(radians(pin.lat)) * cos(radians(latitude)) *
        pow(sin(radians(longitude - pin.lon) / 2), 2)
      )) <= pin.radius_miles;

SELECT '5. Top leads in that radius — aged roof, long-held, owner out of area' AS step;
WITH pin AS (SELECT 28.8117 AS lat, -81.2734 AS lon, 5.0 AS radius_miles),
scored AS (
  SELECT
    parcel_id,
    primary_address,
    owner_name,
    roof_age,
    year_built,
    years_since_sale,
    owner_out_of_area,
    round(total_just_value)                                     AS just_value,
    round(3958.8 * 2 * asin(sqrt(
          pow(sin(radians(latitude - pin.lat) / 2), 2) +
          cos(radians(pin.lat)) * cos(radians(latitude)) *
          pow(sin(radians(longitude - pin.lon) / 2), 2)
        )), 2)                                                  AS miles_from_pin
  FROM properties, pin
  WHERE latitude IS NOT NULL AND roof_age > 15 AND has_building
)
SELECT * FROM scored
WHERE miles_from_pin <= 5.0
ORDER BY roof_age DESC, just_value DESC
LIMIT 15;

SELECT '6. Provenance — read straight out of the same IPFS directory' AS step;
SELECT
  runId,
  rows,
  columns,
  roofsOlderThan15Years,
  provenance.snapshotPrefix                                     AS s3_snapshot,
  provenance.sourceFingerprint                                  AS source_fingerprint
FROM manifest;
