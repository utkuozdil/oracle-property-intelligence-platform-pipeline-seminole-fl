/**
 * Overture Maps places configuration — the pipeline's business-records source.
 *
 * Every value here was confirmed against a live response on 2026-09-01 with DuckDB 1.5.5.
 * See `docs/seminole-business-places-findings.md` for the captures, and for why this source
 * replaced the Florida state corporate registry (Sunbiz).
 *
 * The whole source is read with **no credentials and no request signing**: the Overture
 * release lives in a public S3 bucket and the county boundary comes from a public Census
 * endpoint. There is nothing to rotate and nothing to pay for at rest.
 */

/**
 * The pinned Overture release.
 *
 * Pinned rather than resolved at run time, and the pin is the whole point. Overture's
 * taxonomy changes quarterly and its S3 bucket retains only the two most recent releases,
 * so a category count is meaningless without the release it was counted in. `resolveRelease`
 * in `./release.ts` checks this pin against the live STAC catalog and *reports* a drift; it
 * never silently follows it.
 */
export const OVERTURE_RELEASE = '2026-08-19.0';

/** The release this one supersedes. Retained on S3, which is what makes a real diff possible. */
export const OVERTURE_PREVIOUS_RELEASE = '2026-07-22.0';

export const OVERTURE_STAC_CATALOG = 'https://stac.overturemaps.org/catalog.json';
export const OVERTURE_BUCKET = 'overturemaps-us-west-2';
export const OVERTURE_REGION = 'us-west-2';

/** Public S3 glob for the places theme of one release. */
export function overturePlacesGlob(release: string): string {
  return `s3://${OVERTURE_BUCKET}/release/${release}/theme=places/type=place/*.parquet`;
}

/** Citation URL recorded as `source_url` on every record. */
export function overtureSourceUrl(release: string): string {
  return `s3://${OVERTURE_BUCKET}/release/${release}/theme=places/type=place/`;
}

export const COUNTY_NAME = 'Seminole';
export const COUNTY_STATE = 'FL';
export const COUNTY_FIPS = '12117';

/**
 * Census TIGERweb, queried for one county polygon rather than downloading the 100+ MB
 * national TIGER/Line shapefile.
 *
 * One HTTPS GET returns 108 KB of GeoJSON at 2,647 vertices — full TIGER/Line resolution,
 * not a generalised cartographic boundary. The layer reports its own vintage, which is
 * recorded as provenance because "current" is a moving target and the skill this tier
 * follows forbids letting a rerun drift onto a new boundary unnoticed.
 */
export const TIGERWEB_COUNTY_LAYER =
  'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer/1';

/**
 * Incorporated place boundaries, used to assign each business a jurisdiction.
 *
 * Queried by envelope rather than by county, because a city polygon is not a child of a
 * county polygon — the query has to be spatial and then intersected with the county clip.
 */
export const TIGERWEB_PLACE_LAYER =
  'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Places_CouSub_ConCity_SubMCD/MapServer/4';

/** Vintage reported by both layers on 2026-09-01, recorded as provenance. */
export const TIGERWEB_VINTAGE = '2025-01-01';

/**
 * Measured county extent, from the TIGERweb polygon.
 *
 * Used *only* to prune Parquet row groups before the geometric test, and injected into the
 * SQL as literals so the predicate reaches the row-group statistics. A count taken at this
 * stage is a diagnostic and is never reported as a county count: the boundary bbox holds
 * 31,168 places against 26,446 actually inside the county.
 */
export const COUNTY_BBOX = {
  xmin: -81.459728,
  ymin: 28.610501,
  xmax: -80.986868,
  ymax: 28.879227,
} as const;

/**
 * Jurisdiction vocabulary, assigned by geometry.
 *
 * These are exactly the eight values the property snapshot's `jurisdiction` column carries,
 * which is what makes jurisdiction a usable join key between a business and a parcel. A
 * business inside the county but outside every municipal polygon is unincorporated.
 */
export const UNINCORPORATED = 'Unincorporated Seminole County';

export const SEMINOLE_MUNICIPALITIES = [
  'Altamonte Springs',
  'Casselberry',
  'Lake Mary',
  'Longwood',
  'Oviedo',
  'Sanford',
  'Winter Springs',
] as const;

export type Jurisdiction = (typeof SEMINOLE_MUNICIPALITIES)[number] | typeof UNINCORPORATED;

/**
 * The full `taxonomy.hierarchy` path for roofing work, as Overture publishes it in this
 * release.
 *
 * Keyed on the hierarchy path rather than on the deprecated flat `categories.primary`,
 * because `categories` is removed from the September 2026 release onward. Both agreed at
 * 162 records in this release, which is the evidence that switching the key changed nothing
 * except the field it reads.
 */
export const ROOFING_TAXONOMY_PATH =
  'services_and_business/home_service/ceiling_and_roofing_repair_and_service/roofing';

/** The parent branch. One `ceiling_service` record sits beside roofing and is not roofing. */
export const ROOFING_TAXONOMY_BRANCH = 'ceiling_and_roofing_repair_and_service';

/** The leaf label, as `taxonomy.primary` and as deprecated `categories.primary`. */
export const ROOFING_TAXONOMY_LEAF = 'roofing';

/**
 * Approved `sources[].dataset` providers.
 *
 * Comparison is case-insensitive, because live values arrive as `Microsoft`, `AllThePlaces`,
 * `RenderSEO`. The stored spelling is the source's own.
 *
 * The gate fails closed and is run twice — once on the clipped extract and again on the
 * table about to be published. `osm` is a hard stop regardless of casing: its share-alike
 * terms are incompatible with republishing this artifact, and an OSM row reaching the
 * published Parquet would be a licence violation rather than a data-quality problem.
 */
export const APPROVED_SOURCE_DATASETS: ReadonlySet<string> = new Set([
  'meta',
  'microsoft',
  'foursquare',
  'pinmeto',
  'krick',
  'renderseo',
  'dac',
  'brightquery',
  'alltheplaces',
  'overture',
  'overture-signals',
]);

export const FORBIDDEN_SOURCE_DATASETS: ReadonlySet<string> = new Set(['osm']);

/**
 * Confidence policy: nothing is dropped at ingest.
 *
 * Overture already applies its own minimum, and confidence correlates with *provider*, not
 * with truth — an extraction-time threshold silently varies coverage by who contributed the
 * record. So every clipped place is kept, `confidence` is published verbatim, and a
 * `confidence_band` is published beside it so a consumer can filter without re-deriving
 * bucket edges. The distribution is reported in the run summary and in the findings doc.
 *
 * Measured range across the 26,446 clipped Seminole places: 0.0178 to 1.0, median 0.9199.
 * The 0.53-0.92 range seen in a small hand sample is not the population range.
 */
export const CONFIDENCE_BAND_EDGES = [0.5, 0.6, 0.7, 0.8, 0.9, 0.95] as const;

/**
 * A *recommended consumer default*, not an ingest filter.
 *
 * Set to the same 0.6 the BBB tier uses as its match floor, so "what this pipeline is
 * willing to assert" means one number across both tiers. A consumer that wants full
 * recall ignores it; nothing in this tier applies it.
 */
export const RECOMMENDED_CONFIDENCE_FLOOR = 0.6;

/**
 * Row-group size for the published Parquet.
 *
 * Matches the query-table artifact: the file is fetched over an IPFS gateway by range
 * request, so row groups are what let a filtered query read a fraction of the file.
 */
export const PUBLISH_ROW_GROUP_SIZE = 20_000;

/**
 * Timeout for a boundary fetch. Both TIGERweb queries returned in under 7 s; this is the
 * ceiling at which a hung request is treated as a failure rather than waited on.
 */
export const BOUNDARY_TIMEOUT_MS = 90_000;
