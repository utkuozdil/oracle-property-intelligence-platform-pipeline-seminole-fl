/**
 * S3 layout for the places tier, and the local mirror of it.
 *
 * Everything hangs off `places/` inside the prefixes the data bucket already owns, so this
 * tier adds no top-level prefix. `raw/places/` is a sibling of `raw/expanded/` rather than a
 * child, for the same reason `raw/permits/` and `raw/bbb/` are: the seven-day expiry on
 * `raw/expanded/` matches a literal prefix, and the boundary GeoJSON a count was computed
 * against has to outlive the count.
 *
 * The keys are the interface. A local run writes the identical key structure under an
 * output directory, so choosing local or S3 is a deployment detail and never changes what a
 * run produces or where a consumer looks for it.
 */
import { DATA_PREFIXES } from '@oracle-seminole/shared';

const PLACES = 'places/';

/**
 * The exact boundary bytes the Census served, kept as the provenance record.
 *
 * Keyed by vintage and fingerprint rather than by run: two runs a month apart against an
 * unchanged boundary write the same key, which is what makes "the boundary did not move"
 * observable instead of assumed.
 */
export function rawBoundaryKey(options: {
  layer: 'county' | 'places';
  vintage: string;
  fingerprint: string;
}): string {
  return (
    `${DATA_PREFIXES.raw}${PLACES}boundary/layer=${options.layer}/` +
    `vintage=${options.vintage}/${options.fingerprint.slice(0, 16)}.geojson`
  );
}

/**
 * The clipped business locations, partitioned by jurisdiction.
 *
 * Partitioned by `jurisdiction` rather than by `geohash5` — unlike the parcel snapshot —
 * because the questions asked of businesses are jurisdictional ("roofing contractors in
 * Longwood") while the questions asked of parcels are geometric ("within five miles of a
 * pin"). Both keys are on every row, so either access pattern still works.
 */
export function stagedPlacesPrefix(release: string): string {
  return `${DATA_PREFIXES.staged}${PLACES}business-locations/release=${release}/`;
}

/** The single consolidated Parquet a consumer queries over HTTP. */
export function publishedPlacesTableKey(release: string): string {
  return `${DATA_PREFIXES.publish}${PLACES}business-locations/release=${release}/places.parquet`;
}

/** The roofing business -> permit contractor -> BBB rating join. What the CRM reads. */
export function roofingMatchesKey(release: string): string {
  return `${DATA_PREFIXES.staged}${PLACES}roofing-matches/release=${release}/matches.ndjson`;
}

/**
 * A stable pointer to the newest completed release, mirroring `publish/current.json` and
 * the BBB tier's `contractor-ratings/current.json`.
 *
 * Consumers read this one fixed key and follow it, so no reader has to know a release id.
 * Written last, after every artifact is durable, so it never points at a partial run.
 */
export function currentPointerKey(): string {
  return `${DATA_PREFIXES.publish}${PLACES}current.json`;
}

function manifestPrefix(runId: string): string {
  return `${DATA_PREFIXES.manifests}${PLACES}${runId}/`;
}

export function summaryKey(runId: string): string {
  return `${manifestPrefix(runId)}summary.json`;
}

export function roofingJoinSummaryKey(runId: string): string {
  return `${manifestPrefix(runId)}roofing-join.json`;
}

/**
 * Where a local run writes.
 *
 * `PLACES_OUT_DIR` wins over the default so a local run cannot be pointed at a shared
 * location by accident, and the default is a dotted directory alongside the other tiers'
 * scratch directories so it is obviously not source.
 */
export function resolveOutputDir(override?: string): string {
  return override ?? process.env.PLACES_OUT_DIR ?? '.places-work';
}
