/**
 * BBB (Better Business Bureau) source configuration.
 *
 * Every value here was confirmed against a live response on 2026-09-01. See
 * `docs/seminole-bbb-findings.md` for the captures.
 *
 * This tier reverses an earlier conclusion that BBB was bot-protected and needed a
 * headless-Chromium tier. It is not, and it does not: the search endpoint serves complete
 * results to a plain HTTPS GET carrying a browser User-Agent, and the whole result set
 * arrives as JSON embedded in the HTML. No browser is used here, and none should be added.
 */

/**
 * The search endpoint. `find_loc` is a `City, ST` string, `find_text` is a free-text term
 * matched against both business names and category names.
 */
export const BBB_SEARCH_URL = 'https://www.bbb.org/search';
export const BBB_ORIGIN = 'https://www.bbb.org';

/**
 * A realistic browser agent. Not defended against here so much as basic manners: this is
 * a public site being read by a robot, and the agent is the only place to say so honestly
 * while still getting the same page a person would.
 */
export const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

/**
 * The global containing the search results, assigned inline in the document head.
 *
 * The rendered HTML is a React tree and is not a stable parse target; this global is the
 * same data the page renders from, so it is the parse target instead.
 */
export const PRELOADED_STATE_GLOBAL = 'window.__PRELOADED_STATE__';

/** Results per page. Server-fixed; there is no page-size parameter. */
export const RESULTS_PER_PAGE = 15;

/**
 * The endpoint's real pagination ceiling, and a hard coverage limit rather than a
 * politeness one.
 *
 * A Sanford roofing search reports `totalResults: 5791` but `totalPages: 15`. Page 16
 * cannot be reached, so any single search term tops out at 225 records no matter how many
 * matches exist. Coverage past that comes from more *searches* — narrower terms, more
 * cities, and the per-contractor name lookups — never from more pages.
 */
export const MAX_PAGES_PER_SEARCH = 15;

/**
 * Politeness ceiling: one request at a time, ~1 s apart, jittered.
 *
 * Pages 1-3 were driven at this cadence with no rate limiting, no degradation, and no
 * challenge. That is the evidence available, so it is also the ceiling — the point at
 * which BBB starts refusing was deliberately not probed.
 */
export const SEARCH_CONCURRENCY = 1;
export const SEARCH_DELAY_MS = 1_000;
export const JITTER_RATIO = 0.3;

export const REQUEST_TIMEOUT_MS = 30_000;

/** Retries inside one worker. Repeated failure is a signal to stop, not to grind. */
export const MAX_REQUEST_ATTEMPTS = 3;

/**
 * Statuses treated as a refusal.
 *
 * Deliberately *not* body-marker driven, unlike the permit tier. The BBB search page
 * contains the word "captcha" and a `challenge-platform` script tag on every successful
 * response — they belong to Cloudflare's always-present client bootstrap, not to a
 * challenge being served. Grepping for either is what produced the earlier false
 * "BBB is bot-protected" conclusion. A body is judged by whether it carries a parseable
 * result payload, which is what `MissingResultPayloadError` is for.
 */
export const BLOCK_STATUSES = new Set([403, 429, 503]);

/**
 * Seminole County municipalities, plus the county seat used as the anchor for name
 * lookups.
 *
 * The permit portal covers unincorporated Seminole County only, while these cities issue
 * their own permits — so this list is about BBB *search* coverage, not permit coverage.
 */
export const SEMINOLE_CITIES = [
  'Sanford',
  'Altamonte Springs',
  'Casselberry',
  'Lake Mary',
  'Longwood',
  'Oviedo',
  'Winter Springs',
] as const;

export type SeminoleCity = (typeof SEMINOLE_CITIES)[number];

/** County seat. Used as `find_loc` for name lookups, which are not location-bound. */
export const ANCHOR_CITY = 'Sanford';

export const STATE = 'FL';

/**
 * Seed terms for the per-city sweep, so the tier has roofing coverage before the permit
 * harvest finishes. These match BBB's own category names.
 */
export const ROOFING_SEED_TERMS = ['Roofing Contractors'] as const;

/**
 * BBB category ids that count as roofing work, read off live records.
 *
 * `10126-*` is the roofing family. Kept as a prefix rather than an enumeration because the
 * sub-codes (commercial, tile, metal, ...) are open-ended.
 */
export const ROOFING_CATEGORY_PREFIX = '10126';

/** Letter grades, best to worst, plus `NR` for not-rated. */
export const RATING_GRADES = [
  'A+',
  'A',
  'A-',
  'B+',
  'B',
  'B-',
  'C+',
  'C',
  'C-',
  'D+',
  'D',
  'D-',
  'F',
  'NR',
] as const;

export type RatingGrade = (typeof RATING_GRADES)[number];

const RATING_GRADE_SET: ReadonlySet<string> = new Set(RATING_GRADES);

export function isRatingGrade(value: string): value is RatingGrade {
  return RATING_GRADE_SET.has(value);
}

/**
 * How long a harvested search stays fresh.
 *
 * A BBB letter grade moves on the order of months, and the ledger exists so a re-run
 * triggered by newly landed permits pays only for the contractors it has not seen. Thirty
 * days is well inside the rate at which grades change and well outside the rate at which
 * this pipeline re-runs.
 */
export const DEFAULT_FRESHNESS_DAYS = 30;

/**
 * Schema version of the records cached in the ledger.
 *
 * The ledger stores parsed records, not raw HTML, so a change to the record shape makes
 * every existing entry unusable. Bumping this invalidates them all rather than letting a
 * re-run deserialize an old shape into a new type and fail — or worse, succeed with fields
 * silently missing.
 *
 * v2 added `alsoKnownAs`, after BBB was observed returning one business id under both its
 * legal and its trade name.
 */
export const LEDGER_SCHEMA_VERSION = 2;

/**
 * Match-confidence floor for a claimed join.
 *
 * Anything below this is written to the unmatched list with its best candidate and score
 * attached, rather than being recorded as a match. An overstated join is worse than an
 * honestly low match rate: a wrong rating shown against a contractor's name is a factual
 * claim about a real business.
 */
export const MATCH_CONFIDENCE_FLOOR = 0.6;

/**
 * The permit portal's contractor column is 30 characters wide and truncates without an
 * ellipsis, so a 30-character permit contractor name is assumed cut off. 13 of the 47
 * distinct names in the permit fixtures are exactly this long.
 */
export const PERMIT_CONTRACTOR_NAME_MAX_LENGTH = 30;
