/**
 * The permit tier's published shape, and the decisions a consumer cannot re-derive.
 *
 * `publish/` held parcels only, so the CRM reported `permitsAvailable: false` and refused
 * every permit question. This module and {@link ./permit-publish} put permit history under
 * the same prefix, at the same kind of stable pointer, so the refusal can become an answer.
 *
 * Three properties of the source data drive everything here, and each of them is a coverage
 * statement that has to survive into the artifact rather than being smoothed over.
 *
 * **The census says a permit exists; it never says whether it is open.** `staged/permits/census/`
 * is a month-by-month sweep of the county's permit list — application number, parcel, issue
 * date, type, contractor. Lifecycle comes only from the per-permit status detail in
 * `staged/permits/status/`, which is harvested application by application and covers a tiny
 * fraction of the census. A permit with no status record is therefore `unknown`, not `closed`:
 * treating absence as closure would be a guess presented as a fact, and it would silently
 * shrink the very population the demo question is about.
 *
 * **Open duration is an observation, not a property.** Source B reports how long a permit has
 * been open as of the moment it was read. Publishing that number without the moment attached
 * would make it drift into a lie the day after publication, so every row carries
 * `open_duration_observed_at` and the manifest states a single `referenceDate`. A consumer
 * reads years-open directly and never does date arithmetic against an unstated "now".
 *
 * **The sweep is still running.** Coverage is a contiguous run of months that grows while the
 * harvester walks forward, so the artifact publishes its own window and says what falls
 * outside it. That is what lets a consumer distinguish "this parcel has no permits" from
 * "the harvest has not reached that year yet" — the same distinction the CRM already makes
 * for parcels, and the one it must be able to keep making.
 */

/** Days in an average Gregorian year, matching `openDurationYears` in the permits tier. */
const DAYS_PER_YEAR = 365.25;

/**
 * The permit portal's parcel id, rendered the way the published snapshot spells it.
 *
 * The two sources disagree: the portal renders `08-21-29-524-0000-1100` and the appraisal
 * snapshot stores the bare 17 characters. Joining the spellings directly matches nothing, and a
 * zero-match join is indistinguishable from "these permits touch no published parcel".
 *
 * The permits tier already solved this, so this is a transcription of `normaliseParcelId` into
 * SQL rather than a second normalisation — the join happens inside DuckDB over 388,289 rows, and
 * streaming them through a JavaScript function to call the original would cost minutes to reach
 * the same answer. `permits.test.ts` imports the original and asserts the two agree on real
 * parcel ids, including the alphanumeric blocks (`5MF`, `0S00`, `ROW`) that the permits tier
 * documents as having silently broken an earlier, stricter version of this.
 */
export function CENSUS_PARCEL_ID_SQL(column: string): string {
  return `upper(replace(${column}, '-', ''))`;
}

/**
 * Whether the portal's parcel id is well formed, as SQL.
 *
 * A transcription of `PARCEL_ID` from the permits tier, held equivalent to it by the same test.
 * The last three blocks are alphanumeric rather than numeric; requiring digits throughout looks
 * right and rejects 44% of real Seminole ids.
 */
export function WELL_FORMED_PARCEL_ID_SQL(column: string): string {
  return `regexp_full_match(${column}, '^[0-9]{2}-[0-9]{2}-[0-9]{2}-[0-9A-Z]{3}-[0-9A-Z]{4}-[0-9A-Z]{4}$')`;
}

/**
 * The application-type code, as SQL.
 *
 * `R100 REROOF RESIDENTIAL` -> `R100`. The county puts the code in the description's leading
 * token and nowhere else, and it is the field that decides whether a permit is roofing work.
 *
 * Published as its own column even though `roofing_relevant` is already published, because the
 * consumer has its own roofing vocabulary and its own opinion about how to apply it. Handing it
 * the code lets it classify for itself and disagree visibly; handing it only a boolean makes
 * this tier's classification unauditable.
 *
 * A transcription of `applicationCodeOf` from the permits tier, held equivalent by test.
 */
export function APPLICATION_TYPE_CODE_SQL(column: string): string {
  return `regexp_extract(trim(${column}), '^([A-Z0-9]{3,4})\\s', 1)`;
}

/**
 * The permit-type code, as SQL.
 *
 * `BPFN BUILDING PERMIT FENCE/WALL` -> `BPFN`. A different vocabulary from the application type
 * and carried separately, because the consumer matches roofing against both.
 */
export function PERMIT_TYPE_CODE_SQL(column: string): string {
  return `regexp_extract(trim(${column}), '^([A-Z0-9]+)\\s', 1)`;
}

/**
 * A permit status record as staged, plus when it was observed.
 *
 * `observedAt` is not a field of the staged record — see {@link reduceToCurrentObservation}
 * for why it is supplied from outside and why that matters.
 */
export interface StatusObservation {
  appNo: string;
  runId: string;
  /** Observation time, as an ISO-8601 instant. Ordering key for the reduction. */
  observedAt: string;
  parcelId: string | null;
  applicationDate: string | null;
  applicationType: string | null;
  lifecycle: string;
  rawStatus: string;
  canonicalStatus: string;
  terminal: boolean;
  roofingRelevant: boolean;
  generalContractor: string | null;
  tenantName: string | null;
  owner: string | null;
  address: string | null;
  closedDate: string | null;
  openDurationDays: number | null;
  openDurationBasis: string;
}

/**
 * The newest observation of each application.
 *
 * Deliberately not `reduceToCurrent` from `../permits/reconcile-status`, and the reason is a
 * property of the staged data rather than a preference. That reducer orders by a
 * `harvestedAt` field, and no staged status record carries one: every comparison degenerates
 * to the run-id tiebreak, which is lexicographic, so `verify-closed` outranks `roof-hunt-r12`.
 * Measured against the bucket that is exactly backwards — the `verify-*` runs are the oldest
 * objects in the prefix and the `roof-hunt-*` runs the newest — so reusing it would publish
 * each permit's *first* observed status as its current one.
 *
 * Ordering here is on the observation time the publisher supplies from the S3 object's
 * `LastModified`, which is a real observation instant rather than a field that may be absent.
 * The run id still breaks ties, so two batches written in the same second reduce
 * deterministically and the artifact stays byte-reproducible.
 */
export function reduceToCurrentObservation(
  observations: readonly StatusObservation[],
): StatusObservation[] {
  const current = new Map<string, StatusObservation>();

  for (const observation of observations) {
    const held = current.get(observation.appNo);
    const newer =
      !held ||
      observation.observedAt > held.observedAt ||
      (observation.observedAt === held.observedAt && observation.runId > held.runId);
    if (newer) current.set(observation.appNo, observation);
  }

  return [...current.values()].sort((left, right) => (left.appNo < right.appNo ? -1 : 1));
}

/** How long a permit has been open, in years, at the precision the source supports. */
export function openYears(openDurationDays: number): number {
  return Number((openDurationDays / DAYS_PER_YEAR).toFixed(2));
}

/**
 * Published lifecycle for one application.
 *
 * `unknown` is a first-class value and by far the most common one. It means the status detail
 * for this application has not been harvested, which is not the same as the permit being
 * closed and must not be filtered as if it were.
 */
export const PERMIT_STATUSES = ['open', 'closed', 'void', 'unknown'] as const;

export type PublishedPermitStatus = (typeof PERMIT_STATUSES)[number];

/**
 * Lifecycle, and whether the open duration is trustworthy.
 *
 * `openDurationBasis` rather than `lifecycle` decides whether a duration is published: a
 * permit whose raw status has no canonical mapping is quarantined by the permits tier and is
 * not *known* to be open, so publishing a duration for it would put an unclassified record in
 * front of an operator as a multi-year lead.
 */
export function publishedStatus(observation: { lifecycle: string; openDurationBasis: string }): {
  status: PublishedPermitStatus;
  durationTrusted: boolean;
} {
  switch (observation.lifecycle) {
    case 'open':
      return { status: 'open', durationTrusted: observation.openDurationBasis === 'still_open' };
    case 'closed':
      return { status: 'closed', durationTrusted: observation.openDurationBasis === 'closed' };
    case 'void':
      return { status: 'void', durationTrusted: false };
    default:
      return { status: 'unknown', durationTrusted: false };
  }
}

/**
 * Why a permit's contractor has no BBB rating.
 *
 * Three states rather than a nullable rating, because "BBB has no profile for this business"
 * and "nobody has looked yet" are different facts and the demo script asks for the rating
 * "where available". The BBB run searched 405 permit contractors drawn from a slice of
 * roofing permits; the census now spans far more contractors than that, so `not_searched` is
 * the normal case and saying so is the difference between a gap and a silent zero.
 */
export const BBB_LOOKUPS = [
  'rated',
  'matched_unrated',
  'searched_no_match',
  'not_searched',
] as const;

export type BbbLookup = (typeof BBB_LOOKUPS)[number];

export function bbbLookupFor(
  match: { matched: boolean; rating: string | null } | undefined,
): BbbLookup {
  if (match === undefined) return 'not_searched';
  if (!match.matched) return 'searched_no_match';
  return match.rating === null ? 'matched_unrated' : 'rated';
}

export interface MonthCoverage {
  months: number;
  firstMonth: string | null;
  lastMonth: string | null;
  /** True when every month between the first and the last carries an object. */
  contiguous: boolean;
  /** Months inside the window with nothing harvested. Named, never inferred from a total. */
  missingMonths: string[];
}

/**
 * What the census sweep has actually landed, as a window plus its holes.
 *
 * A month count alone cannot distinguish 294 contiguous months from 294 months scattered
 * across four decades, and the two support completely different claims about a parcel with no
 * permits. Both the window and the holes inside it are therefore published.
 */
export function analyseMonthCoverage(harvestedMonths: readonly string[]): MonthCoverage {
  const present = [...new Set(harvestedMonths)].sort();
  const firstMonth = present.at(0) ?? null;
  const lastMonth = present.at(-1) ?? null;

  if (firstMonth === null || lastMonth === null) {
    return { months: 0, firstMonth: null, lastMonth: null, contiguous: true, missingMonths: [] };
  }

  const inWindow = new Set(present);
  const missingMonths = monthsBetween(firstMonth, lastMonth).filter(
    (month) => !inWindow.has(month),
  );

  return {
    months: present.length,
    firstMonth,
    lastMonth,
    contiguous: missingMonths.length === 0,
    missingMonths,
  };
}

/**
 * Every month from `fromMonth` to `toMonth` inclusive.
 *
 * A local copy of the permits tier's own enumeration rather than an import: this module is the
 * publisher's description of coverage and is the one thing that must not move if the
 * harvester's internals are refactored underneath it. It is eight lines and covered by test.
 */
function monthsBetween(fromMonth: string, toMonth: string): string[] {
  const [fromYear, fromIndex] = fromMonth.split('-').map(Number) as [number, number];
  const [toYear, toIndex] = toMonth.split('-').map(Number) as [number, number];

  const months: string[] = [];
  const end = toYear * 12 + (toIndex - 1);
  for (let cursor = fromYear * 12 + (fromIndex - 1); cursor <= end; cursor += 1) {
    months.push(`${Math.floor(cursor / 12)}-${String((cursor % 12) + 1).padStart(2, '0')}`);
  }
  return months;
}

/**
 * The sentence a consumer needs in order to read an absent parcel correctly.
 *
 * Generated from the coverage window rather than written by hand, so it cannot drift away from
 * the data it describes as the sweep advances.
 */
export function absenceMeaning(coverage: MonthCoverage): string {
  if (coverage.firstMonth === null || coverage.lastMonth === null) {
    return 'No permit months have been harvested, so absence from this dataset carries no information at all.';
  }

  const holes = coverage.contiguous
    ? ''
    : ` ${coverage.missingMonths.length} month(s) inside the window are also unharvested and are named in coverage.census.missingMonths.`;

  return (
    `A parcel absent from parcel-index.parquet had no permit issued between ${coverage.firstMonth} ` +
    `and ${coverage.lastMonth}. It says nothing about permits issued before ${coverage.firstMonth} or ` +
    `after ${coverage.lastMonth}, which this sweep has not harvested yet.${holes}`
  );
}
