/**
 * The FDOR cadastral-centroid contract: the second parcel source.
 *
 * FDOR's certified 2025 NAL tax roll joined to parcel centroids and republished as a
 * statewide Esri feature layer. Every constant here was measured against the live
 * service, and the measurements are written up in
 * `docs/seminole-second-source-reconciliation.md`.
 *
 * Mirrored by `oracle_pipeline/constants.py` and `oracle_pipeline/reconcile.py` on the
 * Glue side, which read what this module lands.
 */

/**
 * Every host in this project filters default user agents, and this one is no exception
 * in kind. Held equal to the CAMA source's agent so there is one string to change.
 */
export { SOURCE_USER_AGENT as FDOR_USER_AGENT } from './source';

/** Layer 0 of the statewide service. Query, metadata, and statistics all hang off this. */
export const FDOR_LAYER_URL =
  'https://services9.arcgis.com/Gh9awoU677aKree0/ArcGIS/rest/services/' +
  'Florida_Statewide_Parcel_Centroid_Version/FeatureServer/0';

/** Logical name of the source in the DynamoDB ledger (`SOURCE#<name>`). */
export const FDOR_SOURCE_NAME = 'seminole-fdor';

/**
 * Seminole's county code **in the records**, not in FDOR's filenames.
 *
 * 59 is Osceola. FDOR's own NAL file listing publishes Seminole as `Seminole 58`, which
 * is Orange's code — the numeric code in a published filename is demonstrably unreliable
 * and the in-record `CO_NO` is not. Corroborated by every `CO_NO=69` record carrying a
 * `STATE_PAR_` prefixed `C69-` and by its `OWN_CITY` values being Seminole municipalities.
 */
export const FDOR_COUNTY_CODE = 69;

/** Records the live service returns for `CO_NO=69`. */
export const OBSERVED_FDOR_RECORD_COUNT = 179_107;

/**
 * Bounds on the county's record count, ±25%.
 *
 * The roll is republished once a year and the county grows by hundreds of parcels
 * annually, so a count outside this band is a republish that changed shape — most
 * likely a `CO_NO` remap — rather than growth. Checked before anything is downloaded.
 */
export const FDOR_RECORD_COUNT_MIN = Math.round(OBSERVED_FDOR_RECORD_COUNT * 0.75);
export const FDOR_RECORD_COUNT_MAX = Math.round(OBSERVED_FDOR_RECORD_COUNT * 1.25);

/** The service's own page ceiling. A window that would exceed it must sub-page. */
export const FDOR_MAX_RECORD_COUNT = 2_000;

/**
 * Width of one `OBJECTID` window, in ids.
 *
 * **Not** a page size, and the distinction is the whole point of this constant.
 * `resultOffset` paging degrades superlinearly on this service — measured at 8.8 s/page
 * by offset 20k, 37 s/page by 60k, and 51 s/page by 80k, extrapolating to well over an
 * hour for the county. Windowing on the indexed `OBJECTID` instead keeps every request
 * the same cost regardless of how deep into the county it sits: the full 179,107 rows
 * came back in 65 s across 121 requests with zero retries.
 *
 * Seminole's ids span 180,594 values for 179,107 rows, so 1,500-wide windows are
 * near-perfectly packed and comfortably under the 2,000 ceiling. The min and max are
 * re-derived per run rather than hardcoded, because the layer is republished annually.
 */
export const FDOR_OBJECTID_WINDOW = 1_500;

/**
 * Windows fetched at once.
 *
 * Eight is what the measured 65 s run used against this host with zero failures. It is a
 * public ArcGIS Online service rather than a fragile county web server, but there is no
 * reason to push past a rate already proven sufficient.
 */
export const FDOR_FETCH_CONCURRENCY = 8;

/**
 * The 37 fields projected out of the layer's 120.
 *
 * Requesting all 120 raises the payload roughly threefold for columns nothing reads.
 * This set covers the join key, everything the reconciliation compares, the sale
 * qualification gate, and the four FDOR-only enrichment columns.
 */
export const FDOR_FIELDS = [
  // Identity and provenance.
  'OBJECTID',
  'CO_NO',
  'PARCEL_ID',
  'ASMNT_YR',
  'STATE_PAR_',
  // Land use.
  'DOR_UC',
  'PA_UC',
  // Values.
  'JV',
  'AV_SD',
  'AV_NSD',
  'TV_SD',
  'LND_VAL',
  'LND_SQFOOT',
  'NCONST_VAL',
  'PAR_SPLT',
  // Structure.
  'EFF_YR_BLT',
  'ACT_YR_BLT',
  'TOT_LVG_AR',
  'NO_BULDNG',
  'NO_RES_UNT',
  // Sales, with the qualification codes that gate every sale comparison.
  'QUAL_CD1',
  'VI_CD1',
  'SALE_PRC1',
  'SALE_YR1',
  'SALE_MO1',
  'QUAL_CD2',
  'SALE_PRC2',
  'SALE_YR2',
  // Owner.
  'OWN_NAME',
  'OWN_ADDR1',
  'OWN_CITY',
  'OWN_STATE',
  'OWN_ZIPCD',
  // Legal location.
  'TWN',
  'RNG',
  'SEC',
  'CENSUS_BK',
] as const;

export interface ObjectIdWindow {
  /** Inclusive. */
  lo: number;
  /** Exclusive. */
  hi: number;
}

/**
 * Split `[minObjectId, maxObjectId]` into half-open windows of `width` ids.
 *
 * Half-open so consecutive windows cannot both claim a boundary id, which would
 * double-count a parcel and make the feature-count assertion pass on the wrong total.
 * The last window is extended past the maximum by one so the maximum is included.
 */
export function objectIdWindows(
  minObjectId: number,
  maxObjectId: number,
  width: number = FDOR_OBJECTID_WINDOW,
): ObjectIdWindow[] {
  if (!Number.isFinite(minObjectId) || !Number.isFinite(maxObjectId)) {
    throw new RangeError(`OBJECTID bounds must be finite, got ${minObjectId}..${maxObjectId}`);
  }
  if (maxObjectId < minObjectId) {
    throw new RangeError(`OBJECTID max ${maxObjectId} is below min ${minObjectId}`);
  }
  if (!Number.isInteger(width) || width <= 0) {
    throw new RangeError(`window width must be a positive integer, got ${width}`);
  }

  const windows: ObjectIdWindow[] = [];
  for (let lo = minObjectId; lo <= maxObjectId; lo += width) {
    windows.push({ lo, hi: Math.min(lo + width, maxObjectId + 1) });
  }
  return windows;
}

/**
 * The `where` clause for one window.
 *
 * The county filter is repeated on every window rather than relying on the id range
 * alone, because `OBJECTID` ranges are not guaranteed to be contiguous per county — an
 * annual republish could interleave counties and silently pull Orange parcels in.
 */
export function fdorWindowWhere(window: ObjectIdWindow, countyCode = FDOR_COUNTY_CODE): string {
  return `CO_NO=${countyCode} AND OBJECTID>=${window.lo} AND OBJECTID<${window.hi}`;
}

/**
 * Build a fully-formed query URL against layer 0.
 *
 * Encoded by hand rather than through `URLSearchParams`, because this package is also
 * consumed by the browser bundle and compiles without the DOM or Node lib.
 */
export function fdorQueryUrl(params: Record<string, string>): string {
  const query = Object.entries(params)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
  return `${FDOR_LAYER_URL}/query?${query}`;
}

/**
 * Identity of a published FDOR snapshot, used as the ledger key.
 *
 * The service has no ETag worth trusting, so the snapshot is identified by the layer's
 * own `editingInfo.lastEditDate` paired with the county's record count. The edit date
 * moves when the layer is republished; the count guards against an edit date that is
 * bumped without the data changing shape, and against the reverse.
 */
export function fdorSnapshotToken(lastEditDate: number, recordCount: number): string {
  return `edit-${lastEditDate}-n${recordCount}`;
}
