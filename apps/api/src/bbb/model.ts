/**
 * The BBB tier's input and output contracts.
 *
 * Defined locally rather than in `@oracle-seminole/shared` for the same reason the permit
 * tier defines its own: the shared package is owned elsewhere. Nothing here is imported
 * outside `src/bbb/`.
 */
import { z } from 'zod';
import { MAX_PAGES_PER_SEARCH } from './config';

/** Execution input. Every field is optional, so `{}` — what a schedule sends — is valid. */
export const BbbHarvestRequest = z
  .object({
    /**
     * Contractor names to look up, highest-value first. When absent the names are read
     * from the permit census on S3, so a scheduled run needs no input at all.
     */
    contractorNames: z.array(z.string().min(2).max(200)).max(5_000).optional(),
    /** Overrides where permit contractor names are read from. */
    contractorSource: z.enum(['permits', 'request', 'none']).optional(),
    /** Per-city seed sweep. Defaults to on, so coverage exists before permits finish. */
    seedCities: z.boolean().optional(),
    /** Pages per seed search. Capped at the endpoint's own 15-page ceiling. */
    seedPages: z.number().int().min(1).max(MAX_PAGES_PER_SEARCH).optional(),
    /** Hard cap on contractor lookups, so a first run cannot become an all-day one. */
    contractorLimit: z.number().int().min(1).max(5_000).optional(),
    /** Re-fetch searches older than this. Set to 0 to force a full re-fetch. */
    freshnessDays: z.number().int().min(0).max(365).optional(),
  })
  .strict();

export type BbbHarvestRequest = z.infer<typeof BbbHarvestRequest>;

/** Why a search was issued. Kept on every record so coverage can be attributed. */
export const SEARCH_KINDS = ['city_seed', 'contractor_name'] as const;
export type SearchKind = (typeof SEARCH_KINDS)[number];

/**
 * One BBB business, as this tier stores it.
 *
 * `fetchedAt` and `sourceUrl` are not optional metadata: every record in this pipeline
 * carries the instant and the URL it came from, because a letter grade is a claim about a
 * real business and has to be attributable to a specific response.
 */
export interface BbbBusinessRecord {
  /** BBB's own composite id (`<bbbId>_<businessId>_<...>`). Stable across searches. */
  bbbRecordId: string;
  businessId: string;
  /** Highlight tags stripped. See `stripHighlightTags`. */
  businessName: string;
  /**
   * Other names BBB returned for this same business id.
   *
   * BBB answers a search with whichever of a business's names matched it, so one id has
   * more than one name: `0733_90718872_109970` is `3MG Solutions LLC` in a category search
   * and `3MG Roofing & Solar` in a name search — the legal name and the trade name. Both are
   * kept, because a permit lists whichever name the contractor pulled the permit under, and
   * a join that only knew the legal name would miss it.
   */
  alsoKnownAs: string[];
  /** Letter grade, e.g. `A+`. Null when BBB does not publish one. */
  rating: string | null;
  /** BBB's numeric score behind the grade, when present. */
  ratingScore: number | null;
  accredited: boolean;
  streetAddress: string | null;
  /** Derived from `reportUrl`, not from the payload's geolocation-contaminated `city`. */
  city: string | null;
  state: string | null;
  postalCode: string | null;
  /** Payload-reported city, retained only so a disagreement with `city` stays visible. */
  payloadCity: string | null;
  phones: string[];
  primaryCategory: string | null;
  categoryIds: string[];
  roofing: boolean;
  serviceAreas: string[];
  outOfBusiness: boolean;
  /** Absolute URL of the BBB profile. */
  profileUrl: string | null;
  /** Provenance: the exact search URL this record was read from. */
  sourceUrl: string;
  /** Provenance: ISO-8601 instant of the response. */
  fetchedAt: string;
  /** Provenance: S3 key (or local path) of the raw HTML this was parsed from. */
  rawKey: string | null;
  /** Why this business was fetched. */
  searchKind: SearchKind;
  searchTerm: string;
  searchLocation: string;
}

/** How a permit contractor name was matched to a BBB business. */
export const MATCH_TIERS = [
  /** Normalized names are identical. */
  'exact',
  /**
   * The permit name is truncated at the portal's 30-character column width and the BBB
   * name continues it. Cheap to verify and unambiguous when only one candidate qualifies.
   */
  'truncated_prefix',
  /** High token overlap after normalization. */
  'strong',
  /** Plausible token overlap, above the floor but stated as weak. */
  'weak',
] as const;

export type MatchTier = (typeof MATCH_TIERS)[number];

/**
 * The join the UI and the CRM read: a permit contractor name, the BBB business it was
 * matched to, and how much that match is worth.
 *
 * `confidence` and `matchTier` travel with the rating deliberately. A consumer that wants
 * to show only what it can defend filters on them; one that hides them is choosing to.
 */
export interface ContractorRatingMatch {
  /** The permit contractor name exactly as the permit portal rendered it. */
  permitContractorName: string;
  /** Normalized form the match was made on. */
  permitContractorKey: string;
  /** Whether the portal's 30-character column cut the business name itself. */
  permitNameTruncated: boolean;
  /** Permits seen under this contractor name, when the caller supplied counts. */
  permitCount: number | null;
  matched: boolean;
  matchTier: MatchTier | null;
  /** 0-1. Above `MATCH_CONFIDENCE_FLOOR` for a claimed match; the best score otherwise. */
  confidence: number;
  /** Other candidates that scored above the floor. A non-empty list means ambiguity. */
  runnerUpCount: number;
  bbbRecordId: string | null;
  /** BBB's primary name for the matched business. */
  bbbBusinessName: string | null;
  /**
   * The specific name the match was made on, which may be an alias rather than the primary
   * name. Kept so a reviewer can see *why* a match was claimed without re-deriving it.
   */
  bbbMatchedName: string | null;
  rating: string | null;
  ratingScore: number | null;
  accredited: boolean | null;
  city: string | null;
  state: string | null;
  phones: string[];
  profileUrl: string | null;
  sourceUrl: string | null;
  fetchedAt: string | null;
}

/** Counters for reconciliation. Written to the run manifest and reported by the CLI. */
export interface BbbRunSummary {
  runId: string;
  startedAt: string;
  finishedAt: string;
  searchesIssued: number;
  searchesServedFromLedger: number;
  pagesFetched: number;
  requestsMade: number;
  businessesSeen: number;
  businessesDistinct: number;
  roofingBusinesses: number;
  ratingDistribution: Record<string, number>;
  contractorsConsidered: number;
  contractorsMatched: number;
  matchRate: number;
  matchTierCounts: Record<string, number>;
  elapsedSeconds: number;
  requestsPerSecond: number;
  latencyMs: { min: number; median: number; max: number };
  businessesKey: string;
  matchesKey: string;
  warnings: string[];
  /** Limits that shaped this run, so a coverage number is never read without them. */
  limits: {
    maxPagesPerSearch: number;
    resultsPerPage: number;
    endpointResultCeilingPerTerm: number;
    contractorNameSource: string;
  };
}
