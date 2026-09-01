/**
 * Seminole County permit-source configuration.
 *
 * Every value here was confirmed against a live response. Where this file disagrees with
 * `docs/seminole-sources.yaml` the disagreement is deliberate and is called out in a
 * comment — the portal has moved on from parts of that capture, and two of the
 * differences are the kind that silently lose data.
 */

/** Source A — bulk census, queried by application type x calendar month. */
export const SOURCE_A_URL =
  'https://scwebapp2.seminolecountyfl.gov:6443/BuildingPublicrequestportal/';
export const SOURCE_A_ORIGIN = 'https://scwebapp2.seminolecountyfl.gov:6443';

/** Source B — status and open duration, keyed by application number. */
export const SOURCE_B_URL = 'https://semc-egov.aspgov.com/Click2GovBP/selectpermit.html';
export const SOURCE_B_ROOT = 'https://semc-egov.aspgov.com/Click2GovBP/';

/**
 * A realistic browser agent is mandatory on Source A — a default `curl`/`node` agent is
 * filtered and the socket stalls rather than returning a status.
 */
export const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

/** WebForms control naming. `$` in POST names, `_` in the Telerik client-state names. */
export const CONTROL_PREFIX = 'ctl00$ContentPlaceHolder7$BuildingPublicRequestPortal1$';
export const CONTROL_ID_PREFIX = 'ctl00_ContentPlaceHolder7_BuildingPublicRequestPortal1_';
export const GRID_TABLE_ID = `${CONTROL_ID_PREFIX}PermitListingForTypeRadGrid_ctl00`;
export const DATE_VALIDATOR_ID = `${CONTROL_ID_PREFIX}dateCompareValidator`;

/** The submit button posts `Submit` wrapped in non-breaking spaces. */
export const SUBMIT_BUTTON_VALUE = '\u00a0Submit\u00a0';

/** Telerik's date bounds, read off the page. */
export const PICKER_MIN_DATE = '1980-01-01';
export const PICKER_MAX_DATE = '2099-12-30';

/** Grid page size. Server default, and the largest of 10/20/50. */
export const GRID_PAGE_SIZE = 50;

/**
 * Positional grid columns — the grid renders `<thead style="display:none;">` with a
 * single empty `<th>`, so there is no header row to key off. Position is the only
 * contract available, and a row that does not have exactly this many cells is rejected
 * rather than mapped by guess.
 */
export const CENSUS_COLUMNS = [
  'appNo',
  'description',
  'parcelId',
  'propertyAddress',
  'cityCode',
  'stateCode',
  'zipCode',
  'propertySubdivision',
  'structureSequence',
  'permitTypeSequence',
  'issueDate',
  'permitType',
  'ownerName',
  'contractorName',
  'valuationAmount',
] as const;

export const CENSUS_COLUMN_COUNT = CENSUS_COLUMNS.length;

/** `ALL TYPES`. Sweeping this and filtering client-side beats sweeping 9 roofing codes. */
export const ALL_TYPES_CODE = 'ALL';

/**
 * Roofing application-type codes, used to tag census rows rather than to narrow the
 * sweep. The active vocabulary changes over time (`EZRO` was empty in 2026-08 but had
 * 211 rows in 2022-10), which is the second reason the sweep takes `ALL`.
 *
 * This vocabulary reads the *description*'s leading code and is what `roofingRelevant`
 * on a census row means. It is not the whole roofing population — see
 * {@link ROOFING_PERMIT_TYPE_CODES}.
 */
export const ROOFING_TYPE_CODES = new Set([
  'EZRO',
  'C202',
  'R200',
  'R300',
  'C110',
  'R100',
  'A998',
  'C998',
  'R800',
]);

/**
 * Roofing codes in the `permitType` column, which is a second and independent vocabulary.
 *
 * A census row carries two type fields and they disagree about roofing far more often than
 * they look like they should. `roofingRelevant` is derived from the description's code, and
 * measured over all 368 harvested months it marks 55,957 rows; matching these two codes in
 * `permitType` instead marks 60,245, and 17,933 *applications* are found by this vocabulary
 * and by no description code at all.
 *
 * `2-10436` is the case that makes the point: a $22.8M Sanford commercial job whose
 * description is `C328 OTHER BUILDING COMMERCIAL` — not a roofing code — carrying a
 * `BPRF BLDG PERMIT/ROOF` line. It is roof work, and `roofingRelevant` on every one of its
 * rows is false. Selecting a roofing sweep on the description alone silently drops a quarter
 * of the population.
 *
 * Confirmed complete against all 522,358 harvested rows: no third roofing code exists in
 * this column, and every other code's description was checked for roof wording.
 */
export const ROOFING_PERMIT_TYPE_CODES = new Set(['RR', 'BPRF']);

/**
 * Roof wording in a row's free-text description.
 *
 * Kept as a third selection rule even though it currently adds nothing: measured over the
 * full census it selects exactly the applications {@link ROOFING_TYPE_CODES} already
 * selects, because the nine roofing codes' labels all contain "reroof", "roof" or
 * "shingle". It stays because the code vocabulary demonstrably drifts, and a new roofing
 * code would be caught by its wording on the day it appears rather than whenever someone
 * next audits the enumeration.
 *
 * The leading `(?<![a-z])` is load-bearing: a bare `roof` also matches `waterproofing`,
 * which is not roof work. `re-?roof` is then needed to let `REROOF` back in.
 */
export const ROOFING_DESCRIPTION_PATTERN = /(?<![a-z])roof|shingle|re-?roof/i;

/** First year with data. 1990 and 1993–1995 were probed and are genuinely empty. */
export const DATA_HORIZON_YEAR = 1996;

/**
 * Source A is down daily 23:30–07:00 America/New_York. Connection failures inside this
 * window are expected rather than exceptional, and a sweep is held until it closes.
 */
export const MAINTENANCE_WINDOW = {
  timeZone: 'America/New_York',
  startMinuteOfDay: 23 * 60 + 30,
  endMinuteOfDay: 7 * 60,
} as const;

/**
 * Politeness ceilings. An F5 BIG-IP ASM sits in front of Source B, and the point at
 * which either host starts refusing was deliberately never probed — finding it means
 * getting blocked, and F5 blocks can be sticky by source IP.
 *
 * These are *rate* ceilings, not parallelism hints. They are enforced in-process, and
 * the CDK stack pins each worker's reserved concurrency so the in-process limit is also
 * the account-wide limit.
 */
export const SOURCE_A_CONCURRENCY = 2;
export const SOURCE_B_CONCURRENCY = 3;

/** Inter-request pacing, jittered +-30% so the cadence is not a fixed heartbeat. */
export const SOURCE_A_DELAY_MS = 350;
export const SOURCE_B_DELAY_MS = 250;
export const JITTER_RATIO = 0.3;

export const REQUEST_TIMEOUT_MS = 45_000;

/** Retries inside one worker. Repeated failure is a signal to stop, not to grind. */
export const MAX_REQUEST_ATTEMPTS = 3;

/**
 * F5 ASM block signatures. On any of these the worker stops immediately rather than
 * retrying into a sticky IP ban.
 */
export const WAF_BLOCK_STATUSES = new Set([403, 406, 419, 429, 503]);
export const WAF_BLOCK_MARKERS = [
  'The requested URL was rejected',
  'Support ID',
  'Reference&#32;&#35;',
] as const;

/**
 * Application-status vocabulary observed on Source B, mapped to canonical lifecycle.
 * This is an observed sample and not a documented enumeration, so anything absent is
 * quarantined and alerted rather than bucketed by guess.
 */
export interface StatusMapping {
  canonical: 'pre_issuance' | 'blocked' | 'active' | 'complete' | 'closed' | 'void';
  lifecycle: 'open' | 'closed' | 'void';
  terminal: boolean;
  countsTowardOpenDuration: boolean;
}

export const PERMIT_STATUS_MAPPING: Record<string, StatusMapping> = {
  'IN APPROVAL': {
    canonical: 'pre_issuance',
    lifecycle: 'open',
    terminal: false,
    countsTowardOpenDuration: true,
  },
  'ON HOLD': {
    canonical: 'blocked',
    lifecycle: 'open',
    terminal: false,
    countsTowardOpenDuration: true,
  },
  'PERMIT ISSUED': {
    canonical: 'active',
    lifecycle: 'open',
    terminal: false,
    countsTowardOpenDuration: true,
  },
  'PERMIT COMPLETE': {
    canonical: 'complete',
    lifecycle: 'closed',
    terminal: true,
    countsTowardOpenDuration: false,
  },
  'CERTIFICATE OF COMPLETION': {
    canonical: 'complete',
    lifecycle: 'closed',
    terminal: true,
    countsTowardOpenDuration: false,
  },
  /**
   * Named in the brief alongside the other immutable states. It was not among the seven
   * statuses actually observed, so it is mapped here rather than left to quarantine.
   */
  'CERTIFICATE OF OCCUPANCY': {
    canonical: 'complete',
    lifecycle: 'closed',
    terminal: true,
    countsTowardOpenDuration: false,
  },
  CLOSED: {
    canonical: 'closed',
    lifecycle: 'closed',
    terminal: true,
    countsTowardOpenDuration: false,
  },
  VOIDED: {
    canonical: 'void',
    lifecycle: 'void',
    terminal: true,
    countsTowardOpenDuration: false,
  },
};

/**
 * Jurisdictional ceiling, not a data gap.
 *
 * The Building Public Request Portal covers unincorporated Seminole County only.
 * Municipalities (Altamonte Springs, Sanford, Oviedo, Winter Springs, Casselberry, Lake
 * Mary, Longwood) run their own permit systems, which this harvest does not reach. Every
 * coverage figure this pipeline reports is stated against the unincorporated denominator
 * as well as the countywide one, so the limit is visible in the output rather than
 * implied by it.
 */
export const COVERAGE = {
  countywideParcels: 181_218,
  unincorporatedParcels: 91_041,
  scope: 'unincorporated Seminole County only',
  note: 'Municipal permits are issued by each city and are not exposed by this portal.',
} as const;

/**
 * Terminal permits are immutable and are never re-fetched: once a permit reads
 * `PERMIT COMPLETE`, `VOIDED`, `CLOSED`, `CERTIFICATE OF COMPLETION`, or
 * `CERTIFICATE OF OCCUPANCY`, its status cannot change. Over a 30-year census the
 * overwhelming majority of permits are terminal, so this is the single largest saving
 * available on Source B — the expensive source at ~2.3 s per permit.
 */
export function isTerminalStatus(status: string): boolean {
  return PERMIT_STATUS_MAPPING[normalizeStatus(status)]?.terminal ?? false;
}

export function normalizeStatus(status: string): string {
  return status.replace(/\s+/g, ' ').trim().toUpperCase();
}

export function mapStatus(status: string): StatusMapping | null {
  return PERMIT_STATUS_MAPPING[normalizeStatus(status)] ?? null;
}
