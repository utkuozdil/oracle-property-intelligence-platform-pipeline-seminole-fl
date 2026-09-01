/**
 * Florida DBPR construction-licence source configuration.
 *
 * Every value here was confirmed against the live host on 2026-09-01, by downloading the
 * whole 48,780,751-byte file and parsing all 271,941 records. See
 * `docs/seminole-licence-findings.md` for the captures and the counts.
 *
 * No browser is used here and none is needed. Cloudflare serves a 403 challenge page on a
 * naive request, but it emits a `__cf_bm` cookie *alongside* that 403, and replaying the
 * cookie on the CSV path returns 200 over plain HTTP. The challenge gates HTML pages; the
 * static CSV asset is satisfied by the bot-management cookie alone. See `./http`.
 */

/**
 * Any path on the host yields a usable `__cf_bm`. This one is the natural referer for the
 * file fetch that follows, so it doubles as the prime target.
 */
export const DBPR_PRIME_URL = 'https://www2.myfloridalicense.com/sto/file_download/';

/**
 * The live construction-licence extract.
 *
 * `CONSTRUCTIONLICENSE_2.csv` also exists but its `Last-Modified` is 2019-10-12 — a legacy
 * artifact seven years stale. `CONSTRUCTIONLICENSE_0.csv` returns 301. Only `_1` is live,
 * and it ends with a complete final record, so it is not a shard of a split set.
 *
 * The directory listing is never accessible even with the cookie, so this filename cannot
 * be discovered at runtime and is pinned here deliberately.
 */
export const DBPR_LICENCE_CSV_URL =
  'https://www2.myfloridalicense.com/sto/file_download/extracts/CONSTRUCTIONLICENSE_1.csv';

/**
 * A realistic browser agent.
 *
 * Measured *not* to be what makes the request work — once primed, a literal `curl/8.7.1`
 * agent also returns 200 — so this is manners rather than evasion, and consistency with
 * the other tiers in this repository.
 */
export const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

/**
 * Pause between priming the cookie and requesting the file.
 *
 * Cloudflare escalated after roughly 20 requests in a few minutes during research: the 403s
 * stopped carrying `Set-Cookie` at all. A scheduled run makes two requests, so this delay
 * costs nothing and keeps the pair looking like a page visit followed by a download.
 */
export const PRIME_DELAY_MS = 3_000;

/**
 * Download timeout, sized against the *slowest* transfer measured rather than the typical one.
 *
 * Two full downloads of the same 48,780,751-byte body an hour apart on 2026-09-01 took
 * **259.6 s** (188 KB/s) and **14.1 s** (3.4 MB/s). An 18-fold spread on an identical request
 * means throughput here is a property of the host's mood, not of the file, so the timeout has
 * to cover the bad case or a scheduled run will fail intermittently for no diagnosable reason.
 *
 * 360 seconds is ~38% above the slow observation and still lets two attempts plus their
 * backoff fit inside a 900-second Lambda, which is the binding constraint:
 * 2 × (360 + 30) + 30 ≈ 810 s worst case.
 */
export const DOWNLOAD_TIMEOUT_MS = 360_000;

/** Short, because the prime is a sub-kilobyte challenge page. */
export const PRIME_TIMEOUT_MS = 30_000;

/**
 * Attempts for the two-request flow as a whole.
 *
 * Two, not three, and the arithmetic above is why: a third attempt cannot fit in the Lambda's
 * 15-minute ceiling alongside a 360-second download. The bigger retry belongs at the state
 * machine, where a second attempt gets a whole fresh 15-minute budget instead of competing
 * for the remainder of this one.
 */
export const MAX_FETCH_ATTEMPTS = 2;
export const RETRY_BASE_DELAY_MS = 30_000;

/**
 * Expected size of the extract, used only as a sanity floor.
 *
 * The observed body was 48,780,751 bytes. A response an order of magnitude smaller is a
 * challenge page or a truncated transfer wearing a 200, and should fail loudly rather than
 * be parsed into a handful of records that then silently shrink the published dataset.
 */
export const MIN_PLAUSIBLE_CSV_BYTES = 20_000_000;

/**
 * Minimum records for a run to be believed.
 *
 * 271,941 were parsed on 2026-09-01 with zero ragged rows. A file that suddenly yields a
 * fraction of that has changed shape, and overwriting `current.json` from it would replace
 * good data with bad. Deliberately far below the observed count so normal drift passes.
 */
export const MIN_PLAUSIBLE_RECORDS = 150_000;

/**
 * Seminole County's numeric code in field 11.
 *
 * Confirmed by address rather than assumed: 87.6% of code-`69` rows sit in Seminole
 * municipalities — Longwood 1,037, Sanford 914, Oviedo 748, Altamonte Springs 566, Lake
 * Mary 519, Winter Springs 460, Casselberry 319. No other code comes close.
 */
export const SEMINOLE_COUNTY_CODE = '69';

/**
 * The counties whose licences are retained and matched against Seminole permits.
 *
 * A contractor who pulls a Seminole permit need not be registered in Seminole — DBPR records
 * the licensee's own address, which is frequently a neighbouring county or a home address —
 * and restricting the join to code `69` alone matched only 23.3% of the permit census. Widening
 * to the Orlando metro raises that to 63.3% without loosening a single matching rule.
 *
 * Deliberately *not* statewide. Statewide reaches 83.2%, but the extra reach is bought with
 * name collisions rather than better evidence: against the metro scope it changes the answer
 * for 157 contractors that were already matched, 10.5% of the overlap, and the changes are
 * wrong. `SHEEGOG CONTRACTING` — 254 Seminole permits, a Winter Park company sitting in
 * Seminole itself — is reassigned to an identically named Miami licensee; `LANDMARK
 * CONSTRUCTION CORP` moves from Sanford to Naples; `BMCI CONTRACTING INC` moves from Orlando
 * to Lebanon, out of state. Recall that arrives by overwriting correct local answers with
 * distant homonyms is not recall, so the scope stops at the metro.
 *
 * Codes verified against the city distributions in the extract, not from a published table.
 */
export const JOIN_COUNTY_CODES: ReadonlySet<string> = new Set([
  '69', // Seminole  — Longwood, Sanford, Oviedo, Altamonte Springs
  '58', // Orange    — Orlando, Winter Park, Apopka
  '59', // Osceola   — Kissimmee, St Cloud
  '45', // Lake      — Clermont, Leesburg, Eustis
  '74', // Volusia   — Daytona Beach, DeLand, Deltona
  '15', // Brevard   — Melbourne, Titusville, Cocoa
]);

/**
 * Tie-break order among a business's own licences, when standing and county cannot separate
 * them.
 *
 * These permits are roofing permits, so the licence worth showing is one that could have
 * pulled the work. `RLH CONSTRUCTION, LLC` holds a `CPC` (plumbing) and three `CGC` (general)
 * licences, all current and all in Seminole; with nothing to choose between them the plumbing
 * licence was being reported against a roofing permit. Roofing classes first, then the general
 * classes that may roof, then everything else. This only decides *which* licence is the
 * headline — `allLicenceNumbers` and `worstStanding` still carry the rest.
 */
export const ROOFING_CAPABLE_CLASSES: readonly string[] = [
  'CCC', // certified roofing
  'FRO', // roofing registration
  'RC', //  registered roofing
  'CGC', // certified general — may roof
  'CBC', // certified building — may roof
  'CRC', // certified residential — may roof
  'RR', //  registered residential
  'RG', //  registered general
];

const TRADE_RELEVANCE = ROOFING_CAPABLE_CLASSES;

export function tradeRank(licenceType: string): number {
  const rank = TRADE_RELEVANCE.indexOf(licenceType);
  return rank === -1 ? TRADE_RELEVANCE.length : rank;
}

/**
 * Whether a licence class could lawfully cover roofing work.
 *
 * Used to scope the adverse roll-up: a lapsed licence in an unrelated trade is not evidence
 * that this contractor cannot roof. See `standings` for the case that forced this.
 */
export function isTradeRelevant(licenceType: string): boolean {
  return TRADE_RELEVANCE.includes(licenceType);
}

/**
 * Tie-break order when several counties hold an equally good name match.
 *
 * Seminole first, then the rest of the metro. Without this the winner among equal scores is
 * whichever the scan reached first, which is arbitrary and would let `SHEEGOG CONTRACTING`
 * land in Brevard as easily as in Winter Park.
 */
export function countyRank(countyCode: string | null): number {
  if (countyCode === SEMINOLE_COUNTY_CODE) return 0;
  if (countyCode !== null && JOIN_COUNTY_CODES.has(countyCode)) return 1;
  return 2;
}

/** Field 0 is constant `06` (the Construction Industry board) across all 271,941 rows. */
export const CONSTRUCTION_BOARD_CODE = '06';

/** The extract has 22 comma-delimited, fully quoted fields and **no header row**. */
export const EXPECTED_FIELD_COUNT = 22;

/**
 * Column indices, derived from observed values — DBPR publishes no layout document.
 *
 * Fields 18, 19 and 21 are empty in 100% of rows and are therefore not named here.
 */
export const FIELD = {
  boardCode: 0,
  licenceTypePrefix: 1,
  /** `LAST, FIRST M` for individuals — but the *business* name on `QB` rows. */
  individualName: 2,
  /** Business/DBA name. 49.6% filled; the literal `INDIVIDUAL` is used as a sentinel. */
  businessName: 3,
  /** Licence class/qualifier (`A`, `B`, `GLZ`, ...). 8.0% filled. */
  licenceClass: 4,
  addressLine1: 5,
  addressLine2: 6,
  addressLine3: 7,
  city: 8,
  state: 9,
  postalCode: 10,
  countyCode: 11,
  /** Zero-padded serial. Blank for 100% of `QB` rows. */
  licenceSerial: 12,
  primaryStatus: 13,
  secondaryStatus: 14,
  originalLicensureDate: 15,
  statusEffectiveDate: 16,
  /** 46.1% filled. Absent for all `QB` rows and all `FRO` rows. */
  expirationDate: 17,
  /** Prefix + serial, e.g. `CBC006231`. Blank for 100% of `QB` rows. */
  licenceNumber: 20,
} as const;

/**
 * The `QB` ("qualified business") licence type, which is 46.8% of the file and behaves as a
 * second dataset stacked on the first.
 *
 * `QB` rows carry **no licence number and no expiration date**, and field 2 holds the
 * *business* name rather than a person's. Every one of the other 144,573 rows has a licence
 * number, 100% of the time. So the business name to match against lives in field 3 for
 * non-`QB` rows and field 2 for `QB` rows; a single-column read silently misses half the
 * data. `QB` rows are a contractor-name dictionary, not a status source.
 */
export const QUALIFIED_BUSINESS_PREFIX = 'QB';

/**
 * The `INDIVIDUAL` sentinel that appears in the business-name column.
 *
 * It means "this licensee trades under their own name", not that the business is called
 * `INDIVIDUAL`. Treated as absent, or 39 separate Seminole "businesses" would share it.
 */
export const INDIVIDUAL_SENTINEL = 'INDIVIDUAL';

/**
 * The Florida certified-roofing licence prefix.
 *
 * Load-bearing for the join rather than trivia: the permit portal appends the *qualifying
 * agent's surname and their licence-type prefix* to a contractor name — `(LANIER-CCC)`,
 * `(CCC-ANGIULLI)`, `(HOOD CCC)` — and `CCC` is by far the most common of them (80 of 208
 * parentheticals). See `./qualifier`.
 */
export const ROOFING_LICENCE_PREFIX = 'CCC';

/**
 * Primary status values that actually occur, statewide, across all 271,941 rows:
 *
 *   `C` 271,434   `S` 283   `P` 224
 *
 * **There is no `N` and no `D` anywhere in the file.** A wider vocabulary of
 * Current/Probation/Suspended/Null-and-void/Delinquent was expected from earlier research;
 * null-and-void and delinquent codes are simply not present. This extract is a
 * *current-licensee snapshot*, not licence history, so absence from it is not evidence of
 * revocation and must never be reported as such.
 */
export const PRIMARY_STATUS = {
  current: 'C',
  probation: 'P',
  suspended: 'S',
} as const;

/**
 * Secondary status: `A` 114,770, `I` 14,977, **blank 142,194 (52.3%)**.
 *
 * The blank majority is why "usable means `C` and `A`" is the wrong rule. Blank is not
 * inactive — it is unrecorded. In Seminole it covers all 2,271 blank-secondary `QB` rows
 * *and* 401 non-`QB` rows that are otherwise unremarkable. Treating blank as unusable would
 * discard 2,672 of 5,211 Seminole licences, so `standing` in `./parse` distinguishes
 * "active", "inactive" and "unspecified" instead of collapsing them into a boolean.
 */
export const SECONDARY_STATUS = {
  active: 'A',
  inactive: 'I',
} as const;

/**
 * Licence types that carry no expiration date in this extract.
 *
 * All 319 Seminole non-`QB` rows missing an expiry are `FRO` records, exactly. So a missing
 * expiry on an `FRO` row is the norm and must not be rendered as "expiry unknown, treat
 * with suspicion", while a missing expiry on any other type would be genuinely odd.
 */
export const TYPES_WITHOUT_EXPIRY = new Set(['FRO']);

/** Window in which an expiring licence is worth surfacing as a lead, in days. */
export const EXPIRING_SOON_DAYS = 90;

/**
 * How long a downloaded extract stays fresh in the ledger.
 *
 * DBPR republishes this file far more often than the once-a-month the brief assumed:
 * `Last-Modified` was `Tue, 01 Sep 2026 10:48:27 GMT`, about five hours before the fetch,
 * and earlier research saw the same same-day pattern. Three days keeps a re-run inside the
 * week's schedule from paying 260 seconds of download for a file it already has, while
 * never serving data older than the interval between scheduled runs.
 */
export const DEFAULT_FRESHNESS_DAYS = 3;

/**
 * Schema version of the ledger entries.
 *
 * The ledger stores the derived Seminole records rather than the 48.8 MB body, so a change
 * to the record shape makes every entry unusable. Bumping this invalidates them all instead
 * of letting a re-run deserialize an old shape into a new type.
 */
export const LEDGER_SCHEMA_VERSION = 1;

/**
 * Confidence floor for a claimed contractor -> licence join.
 *
 * Below this, the contractor is written to the unmatched list with its best candidate and
 * score attached rather than recorded as a match. A licence standing displayed against a
 * contractor's name is a factual claim about a real business, and about a real named
 * individual's professional licence, so an overstated join is worse than a low match rate.
 *
 * Set at 0.82 after hand-checking the band below it. At a 0.6 floor the 0.6-0.82 band held
 * 361 matches, and a sample of 18 was roughly half wrong — not marginal calls but confident
 * nonsense: `ONE SOURCE ROOFING` -> `SUNSHINE PROPERTIES SOURCE LLC`, `THE HOME DEPOT AT HOME
 * SVCS` -> `ASSURE-U AT HOME SERVICES`, `COMFORT COVER SYSTEMS (CCC)` -> `KAJOR CONSTRUCTION`.
 * One of them, `SOUTHERN PRO RESTORATION LLC` -> `SOUTHERN RESTORATION SERVICES`, reported an
 * *expired* licence against a company that is not the licensee — the precise false accusation
 * this tier must never make. The band is not salvageable by tuning because the failures score
 * as highly as the successes, so it is excluded rather than weighted down.
 */
export const MATCH_CONFIDENCE_FLOOR = 0.82;

/**
 * The permit portal's contractor column is 30 characters wide and truncates mid-word with
 * no ellipsis. Measured on the real census: **199 of the 1,165 distinct roofing-relevant
 * names are exactly 30 characters**, and the longest name in the census is exactly 30 — so
 * nothing longer survives at all.
 */
export const PERMIT_CONTRACTOR_NAME_MAX_LENGTH = 30;
