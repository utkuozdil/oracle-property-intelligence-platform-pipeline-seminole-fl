/**
 * The licence tier's input and output contracts.
 *
 * Defined locally rather than in `@oracle-seminole/shared` for the same reason the permit
 * and BBB tiers define their own: the shared package is owned elsewhere. Nothing here is
 * imported outside `src/licences/`.
 */
import { z } from 'zod';

/** Execution input. Every field is optional, so `{}` — what a schedule sends — is valid. */
export const LicenceHarvestRequest = z
  .object({
    /**
     * Contractor names to join. When absent they are read from the staged permit census,
     * so a scheduled run needs no input at all.
     */
    contractorNames: z.array(z.string().min(2).max(200)).max(20_000).optional(),
    contractorSource: z.enum(['permits', 'request', 'none']).optional(),
    /** Re-download extracts older than this. 0 forces a fresh download. */
    freshnessDays: z.number().int().min(0).max(365).optional(),
    /**
     * Persist the raw 48.8 MB body for provenance. Off by default: the derived records
     * carry `sourceUrl` and `fetchedAt`, and a copy per run would add ~200 MB a month to
     * the bucket for a file that is republished daily anyway.
     */
    keepRawCopy: z.boolean().optional(),
    /** Restrict matching to roofing-relevant permit contractors. Defaults to true. */
    roofingOnly: z.boolean().optional(),
  })
  .strict();

export type LicenceHarvestRequest = z.infer<typeof LicenceHarvestRequest>;

/**
 * Derived licence standing — the product-facing signal.
 *
 * Deliberately *not* a boolean. The raw file offers a 3-value primary status, a 3-value
 * secondary status that is blank on 52.3% of rows, and an expiry date absent on 53.9% of
 * them; collapsing that into "usable / not usable" throws away the distinction between "we
 * know this licence is inactive" and "DBPR does not record a secondary status for it".
 *
 * Ordered worst to best, because the worst standing is the one worth acting on.
 */
export const LICENCE_STANDINGS = [
  /** Primary status `S`. The strongest negative signal in the file. */
  'suspended',
  /** Primary status `P`. */
  'probation',
  /**
   * Primary status `C` but the expiration date is in the past.
   *
   * This is the closest thing the extract has to "delinquent", and it has to be *derived*:
   * there is no delinquent status code. 375 Seminole non-`QB` licences are in this state.
   */
  'expired',
  /** Current, expiring inside `EXPIRING_SOON_DAYS`. */
  'expiring_soon',
  /** Current and active (`C` + `A`), with an expiry in the future or none expected. */
  'active',
  /**
   * Current with secondary status `I`.
   *
   * A licence the holder has voluntarily placed inactive — not a disciplinary state, and
   * not the same thing as expired, so it is reported as itself.
   */
  'inactive',
  /**
   * Current, with no secondary status recorded.
   *
   * The blank-secondary majority. Worth its own value so a consumer never has to guess
   * whether blank meant active.
   */
  'current_unspecified',
] as const;

export type LicenceStanding = (typeof LICENCE_STANDINGS)[number];

/** One DBPR licence row, as this tier stores it. */
export interface LicenceRecord {
  /**
   * Full licence number (`CCC058022`). **Null for every `QB` row** — 2,498 of the 5,211
   * Seminole rows — which is why it cannot be the primary key of this dataset.
   */
  licenceNumber: string | null;
  /** Licence type prefix (`CCC`, `CGC`, `QB`, ...). */
  licenceType: string;
  /** True for `QB` rows, which carry no licence number, no expiry, and a business name in field 2. */
  qualifiedBusiness: boolean;
  /** Licence class/qualifier (`A`, `B`, `GLZ`). Sparse. */
  licenceClass: string | null;
  /**
   * The licensee as DBPR writes it: `LAST, FIRST M` for individuals, or the business name
   * on `QB` rows. Kept verbatim; `qualifierSurname` carries the parsed surname.
   */
  licenseeName: string;
  /** Surname parsed off `licenseeName`, or null when the row names a business. */
  qualifierSurname: string | null;
  /**
   * Business/DBA name. The `INDIVIDUAL` sentinel is normalised to null, and for `QB` rows
   * this is taken from field 2 — the column that actually holds it.
   */
  businessName: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  countyCode: string | null;
  primaryStatus: string;
  /** `A`, `I`, or null. Null is *unrecorded*, not inactive. */
  secondaryStatus: string | null;
  /** ISO-8601 date, or null. Absent for all `QB` and all `FRO` rows. */
  expirationDate: string | null;
  originalLicensureDate: string | null;
  statusEffectiveDate: string | null;
  standing: LicenceStanding;
  /** True when `standing` is one of suspended / probation / expired. */
  adverse: boolean;
  /** Provenance: the exact URL this record was read from. */
  sourceUrl: string;
  /** Provenance: ISO-8601 instant of the response the record was parsed from. */
  fetchedAt: string;
}

/**
 * How a permit contractor name was joined to a licence.
 *
 * Ordered strongest to weakest, and the order is the cascade in `./match`. The first four
 * tiers are keyed joins on something the permit portal states explicitly, which is a
 * categorically better class of evidence than the name similarity the BBB tier had to rely
 * on — the permit column carries the qualifying agent's surname and licence prefix, and
 * occasionally the licence serial itself.
 */
export const MATCH_TIERS = [
  /**
   * The permit name contains the licence serial outright — `LUNDBERG, DAVID C (1325941)`,
   * `NOLANDS ROOFING (CCC-1335461)`. Exact and unambiguous; nothing outranks it.
   */
  'licence_number',
  /**
   * The parenthetical names a qualifying agent's surname *and* licence prefix which
   * together resolve to exactly one licensee — `JTO CONTRACTING INC (HOOD CCC)`.
   */
  'qualifier_unique',
  /**
   * Surname and prefix resolve to several licensees, but one of them has a business name
   * sharing a distinctive token with the permit name — `COLLIS ROOFING INC (LANIER-CCC`.
   */
  'qualifier_corroborated',
  /**
   * The permit lists an individual in `LAST, FIRST` form and it matches a licensee name —
   * `MCFADDEN, RICHARD DAVID`. The permit portal names individuals far more often than BBB
   * ever could, so this tier has no BBB analogue.
   */
  'individual_name',
  /** Normalized business names identical. */
  'business_exact',
  /** The 30-character permit name is a character prefix the licence business name continues. */
  'business_truncated_prefix',
  /** High token overlap on at least one distinctive token. */
  'business_strong',
] as const;

export type MatchTier = (typeof MATCH_TIERS)[number];

/** Tiers that rest on a key the permit portal stated, not on name similarity. */
export const KEYED_MATCH_TIERS: ReadonlySet<MatchTier> = new Set<MatchTier>([
  'licence_number',
  'qualifier_unique',
  'qualifier_corroborated',
  'individual_name',
]);

/**
 * The join the UI and the CRM read: a permit contractor name and the licence standing of
 * the contractor behind it.
 *
 * One line per permit contractor, matched or not. `matched: false` with `standing: null`
 * means "we could not identify the licensee", which is a different thing to show a user
 * from "this contractor's licence is in bad standing" — and the whole value of this source
 * is not confusing the two.
 */
export interface ContractorLicenceMatch {
  /** The permit contractor name exactly as the portal rendered it. */
  permitContractorName: string;
  /** Normalized form the match was made on. */
  permitContractorKey: string;
  /** Whether the portal's 30-character column cut the business name itself. */
  permitNameTruncated: boolean;
  /** The licence-qualifier parenthetical, parsed. Null when the name carried none. */
  permitQualifier: {
    surname: string | null;
    licencePrefix: string | null;
    licenceSerial: string | null;
  } | null;
  permitCount: number | null;
  matched: boolean;
  matchTier: MatchTier | null;
  /**
   * 0-1. At or above `MATCH_CONFIDENCE_FLOOR` for a claimed match.
   *
   * On an unmatched row this is the best score reached by a candidate that shared something
   * *identifying* with the permit name — a distinctive token, an exact key, or a character
   * prefix. Exactly `0` therefore carries its own meaning: no licensee in the population shared
   * anything but industry vocabulary, so there was no near miss to review rather than a near
   * miss that scored poorly. That distinction is the useful one; a similarity number computed
   * against a different company that merely also does roofing is noise dressed as evidence.
   */
  confidence: number;
  /** True when the tier is a keyed join rather than a name-similarity one. */
  keyedMatch: boolean;
  /** Other candidates that also cleared the floor. Non-zero means genuine ambiguity. */
  runnerUpCount: number;
  licenceNumber: string | null;
  licenceType: string | null;
  licenseeName: string | null;
  licenceBusinessName: string | null;
  standing: LicenceStanding | null;
  adverse: boolean | null;
  primaryStatus: string | null;
  secondaryStatus: string | null;
  expirationDate: string | null;
  city: string | null;
  countyCode: string | null;
  /**
   * Every licence held by the matched licensee, best-standing first.
   *
   * A qualifying agent commonly holds several — `CHONTAS, DEREK STEPHEN` holds three, all on
   * probation, and `LUNDBERG, DAVID C` holds a `CBC` and a `CCC`. Reporting only one would
   * let a clean licence mask a suspended one held by the same person.
   */
  allLicenceNumbers: string[];
  /** The worst standing across `allLicenceNumbers`. This is the number to act on. */
  worstStanding: LicenceStanding | null;
  sourceUrl: string | null;
  fetchedAt: string | null;
}

/** Counters for reconciliation. Written to the run manifest and reported by the CLI. */
export interface LicenceRunSummary {
  runId: string;
  startedAt: string;
  finishedAt: string;
  sourceUrl: string;
  fetchedAt: string;
  /** `Last-Modified` from the response, which is how fresh the *data* is. */
  sourceLastModified: string | null;
  servedFromLedger: boolean;
  downloadBytes: number;
  downloadSeconds: number;
  rowsParsed: number;
  raggedRows: number;
  seminoleLicences: number;
  qualifiedBusinessRows: number;
  licencedRows: number;
  standingDistribution: Record<string, number>;
  /**
   * How the `expired` count splits between the biennial renewal deadline and real lapses.
   *
   * Florida construction licences expire on 31 August of even years, all at once, and DBPR
   * takes weeks to process the renewals. On 2026-09-01 that made 2,287 of 2,658 expired
   * licences — 86% — an artefact of the calendar rather than a contractor in trouble. Reading
   * `expired` as a lead signal without this split would be wrong for most of a two-month
   * window every other year, so the split travels with the number.
   *
   * `note` restates that in the emitted JSON. Someone reading `standingDistribution` in S3 is
   * not reading this comment, and "2,658 expired" invites a badly wrong conclusion on its own.
   */
  expiredBreakdown: {
    /** The biennial deadline this run measured against, e.g. `2026-08-31`. */
    renewalDeadline: string;
    /** Expired on that deadline; most of these will simply renew. */
    atRenewalDeadline: number;
    /** Expired before it, and therefore lapsed through at least one renewal cycle. */
    longLapsed: number;
    /** Generated from the counts above, so it cannot drift away from them. */
    note: string;
  };
  primaryStatusDistribution: Record<string, number>;
  secondaryStatusDistribution: Record<string, number>;
  licenceTypeDistribution: Record<string, number>;
  adverseLicences: number;
  contractorsConsidered: number;
  contractorsMatched: number;
  contractorsMatchedByKey: number;
  matchRate: number;
  keyedMatchRate: number;
  matchTierCounts: Record<string, number>;
  /** Matched contractors whose own best roofing-capable licence is adverse. */
  contractorsWithAdverseLicence: number;
  /**
   * What that count does and does not mean, in the emitted JSON.
   *
   * The number is only interpretable alongside its scoping rule, and the scoping rule is not
   * obvious: it is deliberately *narrower* than "this business has an adverse licence".
   */
  adverseSignalBasis: string;
  elapsedSeconds: number;
  licencesKey: string;
  matchesKey: string;
  warnings: string[];
  /** Limits that shaped this run, so a coverage number is never read without them. */
  limits: {
    /** The counties whose licences were retained; see `JOIN_COUNTY_CODES`. */
    countyCodes: string[];
    /** Whether out-of-county licences were reachable by exact key. */
    statewideExactKeyFallback: boolean;
    contractorNameSource: string;
    confidenceFloor: number;
  };
}
