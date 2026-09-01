/**
 * The places tier's input and output contracts.
 *
 * Defined locally rather than in `@oracle-seminole/shared` for the same reason the permit
 * and BBB tiers define their own: the shared package is owned elsewhere. Nothing here is
 * imported outside `src/places/`.
 */
import { z } from 'zod';
import { OVERTURE_RELEASE } from './config';

const IsoInstant = z.string().datetime();

/** Execution input. Every field is optional, so `{}` — what a schedule sends — is valid. */
export const PlacesIngestRequest = z
  .object({
    /** Overture release to extract. Defaults to the pinned release. */
    release: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}\.\d+$/, 'expected YYYY-MM-DD.N')
      .optional(),
    /**
     * Also extract the previous release and emit a real added/removed/changed delta.
     * Costs one extra full-theme scan, so it is opt-in rather than the default.
     */
    diffAgainst: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}\.\d+$/, 'expected YYYY-MM-DD.N')
      .optional(),
    /** Count only. Writes no Parquet, so a boundary or release change can be probed cheaply. */
    countsOnly: z.boolean().optional(),
    /**
     * Fail the run when the pinned release is no longer the newest in the STAC catalog.
     * Off by default: drift is reported on every run, but only a deliberate operator run
     * treats it as an error.
     */
    failOnReleaseDrift: z.boolean().optional(),
    /** Where artifacts are written. Defaults to `PLACES_OUT_DIR`, then `.places-work/`. */
    outputDir: z.string().min(1).optional(),
  })
  .strict();

export type PlacesIngestRequest = z.infer<typeof PlacesIngestRequest>;

/**
 * The county polygon and the evidence for it.
 *
 * `fingerprint` is a SHA-256 of the exact GeoJSON bytes the Census served. It is the only
 * thing that makes a boundary reproducible: TIGERweb serves "current", so the vintage label
 * alone cannot distinguish two responses, and a boundary that moved without anyone noticing
 * changes every count this tier reports.
 */
export const BoundaryProvenance = z.object({
  source: z.literal('census-tigerweb'),
  layerUrl: z.string().url(),
  vintage: z.string().min(1),
  geoid: z.string().min(1),
  name: z.string().min(1),
  fetchedAt: IsoInstant,
  fingerprint: z.string().length(64),
  vertices: z.number().int().positive(),
  bbox: z.object({
    xmin: z.number(),
    ymin: z.number(),
    xmax: z.number(),
    ymax: z.number(),
  }),
});

export type BoundaryProvenance = z.infer<typeof BoundaryProvenance>;

/**
 * One business location, as this tier publishes it.
 *
 * Deliberately *not* a legal entity. Overture describes where a business operates; a
 * corporate registry describes who is registered. Conflating them is what made the earlier
 * Sunbiz plan look interchangeable with this one, and it is not — a place has coordinates
 * and a category, an entity has officers and a filing date. Nothing here should be loaded
 * into a `companies` table.
 */
export interface BusinessPlaceRecord {
  /** Overture GERS id. The source identity, and the upsert key across releases. */
  gersId: string;
  name: string | null;
  /** Most specific current taxonomy label. */
  taxonomyPrimary: string | null;
  /** Source-provided L0-to-primary path, `/`-delimited. The canonical roll-up field. */
  taxonomyHierarchy: string | null;
  /** Preserved for inspection. An alternate is not primary-category membership. */
  taxonomyAlternates: string[];
  /** Coarse Overture label, for map display and cheap filtering. */
  basicCategory: string | null;
  /**
   * Deprecated flat category, retained only for compatibility while the source still
   * supplies it. It is removed from the September 2026 release onward. Never key on it.
   */
  legacyCategoryPrimary: string | null;
  /** 0-1, as published. Never used to drop a row. */
  confidence: number;
  /** Which `CONFIDENCE_BAND_EDGES` bucket `confidence` falls in. */
  confidenceBand: string;
  latitude: number;
  longitude: number;
  /** 5-character geohash, so places and parcels shard identically. */
  geohash5: string;
  /** Assigned by geometry, from the same vocabulary the property snapshot uses. */
  jurisdiction: string;
  /** TIGER GEOID of the municipality, or null when unincorporated. */
  jurisdictionGeoid: string | null;
  addressFreeform: string | null;
  /** Postal locality as the source wrote it. Not authoritative for jurisdiction. */
  addressLocality: string | null;
  addressPostcode: string | null;
  addressRegion: string | null;
  /**
   * False when the postal locality names a city that is not this record's geometric
   * jurisdiction. 1,602 of 26,446 clipped places disagree; the disagreement is surfaced
   * rather than resolved, because postal city names legitimately cross county lines.
   */
  localityMatchesJurisdiction: boolean;
  /** Overture's explicit closure state. Absence from a release is not closure. */
  operatingStatus: string | null;
  websites: string[];
  phones: string[];
  emails: string[];
  socials: string[];
  brandName: string | null;
  /** Provider lineage, preserved with the source's own spelling. */
  sourceDatasets: string[];
  sourceLicenses: string[];
  /** Provenance: the Overture release this row was read from. */
  overtureRelease: string;
  /** Provenance: the citable source location. */
  sourceUrl: string;
  /** Provenance: ISO-8601 instant of the extract. */
  fetchedAt: string;
  /** First release this GERS id was seen in for this county. */
  firstSeenRelease: string;
  /** Most recent release it was seen in. */
  lastSeenRelease: string;
  /** Whether it is present in the release this artifact represents. */
  isCurrent: boolean;
}

/** Distinct `sources[].dataset` values found, and the gate's verdict on them. */
export interface SourceGateResult {
  /** Source spellings, preserved. */
  datasets: { dataset: string; license: string; places: number }[];
  /** Lowercased values outside the approved set. Non-empty means stop. */
  unknown: string[];
  /** Lowercased forbidden values present. Non-empty means stop. */
  forbidden: string[];
  passed: boolean;
}

/**
 * Release-over-release change, computed by GERS id.
 *
 * `removed` is not closure and must never be rendered as one. A provider can drop a record
 * for its own reasons; Overture states closure in `operating_status`.
 */
export interface ReleaseDelta {
  fromRelease: string;
  toRelease: string;
  fromCount: number;
  toCount: number;
  added: number;
  removed: number;
  /** Present in both releases but with a changed version, name, taxonomy, or confidence. */
  dataChanged: number;
  unchanged: number;
}

export interface ConfidenceBandCount {
  band: string;
  places: number;
  pct: number;
}

/** What one ingest run reports. Written to the run manifest and printed by the CLI. */
export interface PlacesRunSummary {
  runId: string;
  county: string;
  countyFips: string;
  release: string;
  startedAt: string;
  finishedAt: string;
  elapsedSeconds: number;
  boundary: BoundaryProvenance;
  /** Diagnostic only. Never a county count. */
  bboxPrunedCount: number;
  /** The publishable count: inside the county polygon. */
  clippedCount: number;
  /** How many bbox rows the geometric test rejected. */
  bboxOnlyCount: number;
  distinctGersIds: number;
  nullGeometryCount: number;
  jurisdictionCounts: Record<string, number>;
  confidenceBands: ConfidenceBandCount[];
  confidence: { min: number; median: number; mean: number; max: number };
  /** Stated so a consumer knows the floor was published, not applied. */
  recommendedConfidenceFloor: number;
  rowsBelowRecommendedFloor: number;
  roofingCount: number;
  roofingDistinctNames: number;
  operatingStatusCounts: Record<string, number>;
  localityDisagreementCount: number;
  sourceGate: SourceGateResult;
  /**
   * Hash of the observable content, excluding the per-row fetch timestamp.
   *
   * This — not the Parquet bytes — is what "nothing changed since the last run" means, because
   * the brief requires a fetch timestamp on every record and that alone changes every byte.
   */
  contentFingerprint: string;
  delta: ReleaseDelta | null;
  releaseDrift: { pinned: string; latest: string | null; drifted: boolean };
  artifacts: { key: string; bytes: number; rows: number }[];
  warnings: string[];
}

/**
 * The roofing join this tier publishes: one Overture roofing business, the permit contractor
 * it was matched to, and the BBB rating that reached it through that contractor.
 *
 * The chain is two hops and both are fuzzy name matches, so both scores travel with the
 * result. A consumer that shows a BBB grade against an Overture business without showing
 * `permitMatchConfidence` and `bbbMatchConfidence` is choosing to hide how it got there.
 */
export interface RoofingBusinessMatch {
  gersId: string;
  placeName: string;
  placeNameKey: string;
  jurisdiction: string;
  confidence: number;
  addressFreeform: string | null;
  websites: string[];
  phones: string[];
  /** Permit-side match. */
  permitMatched: boolean;
  permitContractorName: string | null;
  permitMatchTier: string | null;
  permitMatchConfidence: number;
  /** Permits recorded under the matched contractor name, when the caller supplied counts. */
  permitCount: number | null;
  /** Other permit contractors that also cleared the floor. Non-zero means ambiguity. */
  permitRunnerUpCount: number;
  /** BBB-side match, reached either directly by name or through the permit contractor. */
  bbbMatched: boolean;
  bbbPath: 'direct' | 'via_permit_contractor' | null;
  bbbBusinessName: string | null;
  bbbRating: string | null;
  bbbRatingScore: number | null;
  bbbMatchConfidence: number;
  bbbProfileUrl: string | null;
}

/** Counters for the roofing join, so the reported rate is a measurement. */
export interface RoofingJoinSummary {
  release: string;
  roofingPlaces: number;
  permitContractorsConsidered: number;
  bbbBusinessesConsidered: number;
  placesMatchedToPermits: number;
  /**
   * Matches in the `exact`, `truncated_prefix` and `strong` tiers only.
   *
   * Reported separately because the `weak` tier does not survive inspection on this join.
   * Overture roofing names and permit contractor names are both dense in the same handful
   * of words — "MID FLORIDA ROOFING" against "MID FLORIDA EXTERIORS", "TOP NOTCH ROOFING"
   * against "TIP TOP ROOFING" — so bigram agreement in the 0.60-0.80 band is mostly two
   * different roofers sharing a vocabulary. This is the number to quote.
   */
  placesMatchedDefensibly: number;
  placesMatchedToBbb: number;
  permitMatchRate: number;
  /** `placesMatchedDefensibly / roofingPlaces`. */
  defensibleMatchRate: number;
  bbbMatchRate: number;
  permitTierCounts: Record<string, number>;
  bbbPathCounts: Record<string, number>;
  /** Distinct permit contractors that reached at least one Overture business. */
  permitContractorsMatched: number;
  /** Permit contractors with no Overture roofing business above the floor. */
  permitContractorsUnmatched: number;
  /**
   * The enrichment-relevant direction: given a permit, can this source name the business?
   * Not the same question as the place-side rate, and not interchangeable with it.
   */
  permitContractorMatchRate: number;
  matchFloor: number;
  /** Tiers counted as defensible. Stated so the number above is reproducible. */
  defensibleTiers: string[];
  /** Stated because a rate without its denominators is not a measurement. */
  denominators: {
    permitContractorSource: string;
    bbbBusinessSource: string;
  };
}

export function assertSummary(summary: PlacesRunSummary): void {
  if (summary.clippedCount !== summary.distinctGersIds) {
    throw new Error(
      `duplicate GERS ids: ${summary.clippedCount} rows but ${summary.distinctGersIds} distinct ids`,
    );
  }
  if (summary.nullGeometryCount !== 0) {
    throw new Error(`${summary.nullGeometryCount} rows have null geometry`);
  }
  if (!summary.sourceGate.passed) {
    throw new Error(
      `source gate failed: forbidden=[${summary.sourceGate.forbidden.join(', ')}] ` +
        `unknown=[${summary.sourceGate.unknown.join(', ')}]`,
    );
  }
  if (summary.release !== OVERTURE_RELEASE && summary.warnings.length === 0) {
    throw new Error('a run on an unpinned release must record why');
  }
}
