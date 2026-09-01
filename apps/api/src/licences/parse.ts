/**
 * Turning a raw DBPR row into a `LicenceRecord`, and deriving licence standing.
 *
 * The standing derivation is the only place in this tier that interprets rather than
 * records, so the reasoning is written next to it.
 */
import {
  EXPIRING_SOON_DAYS,
  FIELD,
  INDIVIDUAL_SENTINEL,
  PRIMARY_STATUS,
  QUALIFIED_BUSINESS_PREFIX,
  SECONDARY_STATUS,
  TYPES_WITHOUT_EXPIRY,
} from './config';
import type { LicenceRecord, LicenceStanding } from './model';

function clean(value: string | undefined): string {
  // Trailing whitespace is common in the city column and would split otherwise-equal keys.
  return (value ?? '').trim();
}

function orNull(value: string): string | null {
  return value.length > 0 ? value : null;
}

/**
 * `MM/DD/YYYY` to ISO-8601 `YYYY-MM-DD`.
 *
 * Returns null rather than an Invalid Date for anything that does not match, because a
 * malformed date must not silently become 1970 and then read as "expired 56 years ago".
 */
export function parseDbprDate(value: string): string | null {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value.trim());
  if (!match) return null;
  const [, month, day, year] = match;
  const monthNumber = Number(month);
  const dayNumber = Number(day);
  if (monthNumber < 1 || monthNumber > 12 || dayNumber < 1 || dayNumber > 31) return null;
  return `${year}-${month}-${day}`;
}

/**
 * The surname off a `LAST, FIRST M` licensee name.
 *
 * Returns null when there is no comma, which is how a `QB` row's business name is told
 * apart from a person's name without a separate flag.
 *
 * Internal spaces are removed because DBPR and the permit portal disagree about them —
 * DBPR writes `MC FADDEN, RICHARD DAVID` where the permit writes `MCFADDEN, RICHARD DAVID`.
 */
export function parseSurname(licenseeName: string): string | null {
  const comma = licenseeName.indexOf(',');
  if (comma < 0) return null;
  const surname = licenseeName
    .slice(0, comma)
    .toUpperCase()
    .replace(/[^A-Z]/g, '');
  return surname.length > 0 ? surname : null;
}

/**
 * Derives standing from primary status, secondary status and expiry.
 *
 * Precedence is worst-first, because the point of this field is to surface the licence a
 * consumer should act on. A suspended licence whose expiry is comfortably in the future is
 * still suspended.
 *
 * `asOf` is a parameter rather than `Date.now()` so the expiry boundary is testable, and so
 * every record in one run is judged against the same instant.
 */
export function deriveStanding(options: {
  primaryStatus: string;
  secondaryStatus: string | null;
  expirationDate: string | null;
  licenceType: string;
  asOf: Date;
}): LicenceStanding {
  const { primaryStatus, secondaryStatus, expirationDate, licenceType, asOf } = options;

  if (primaryStatus === PRIMARY_STATUS.suspended) return 'suspended';
  if (primaryStatus === PRIMARY_STATUS.probation) return 'probation';

  /**
   * Expiry is checked before secondary status, and this ordering is the substantive choice
   * in this function. 375 Seminole licences carry primary `C` with an expiry already in the
   * past — DBPR has no delinquent code, so a lapsed licence looks "Current" unless the date
   * is read. Reporting those as active would invert the exact signal this source exists for.
   */
  if (expirationDate !== null) {
    const expiry = Date.parse(`${expirationDate}T23:59:59Z`);
    if (Number.isFinite(expiry)) {
      if (expiry < asOf.getTime()) return 'expired';
      const daysRemaining = (expiry - asOf.getTime()) / 86_400_000;
      if (daysRemaining <= EXPIRING_SOON_DAYS) return 'expiring_soon';
    }
  } else if (!TYPES_WITHOUT_EXPIRY.has(licenceType) && licenceType !== QUALIFIED_BUSINESS_PREFIX) {
    /**
     * A missing expiry is normal for `QB` and `FRO` — all 319 Seminole non-`QB` rows without
     * one are `FRO`, exactly — and unexplained for anything else. The unexplained case is
     * reported as unspecified rather than guessed at in either direction.
     */
    return 'current_unspecified';
  }

  if (secondaryStatus === SECONDARY_STATUS.inactive) return 'inactive';
  if (secondaryStatus === SECONDARY_STATUS.active) return 'active';
  return 'current_unspecified';
}

const ADVERSE_STANDINGS: ReadonlySet<LicenceStanding> = new Set<LicenceStanding>([
  'suspended',
  'probation',
  'expired',
]);

export function isAdverse(standing: LicenceStanding): boolean {
  return ADVERSE_STANDINGS.has(standing);
}

/**
 * Best-to-worst ranking used to pick a licensee's headline licence and to compute the worst
 * standing across the several licences one qualifying agent commonly holds.
 */
const STANDING_RANK: Record<LicenceStanding, number> = {
  suspended: 0,
  probation: 1,
  expired: 2,
  expiring_soon: 3,
  current_unspecified: 4,
  inactive: 5,
  active: 6,
};

/** The worse of two standings, i.e. the one worth acting on. */
export function worseStanding(left: LicenceStanding, right: LicenceStanding): LicenceStanding {
  return STANDING_RANK[left] <= STANDING_RANK[right] ? left : right;
}

/** Sorts best standing first, for choosing a headline licence to display. */
export function compareStandingBestFirst(left: LicenceStanding, right: LicenceStanding): number {
  return STANDING_RANK[right] - STANDING_RANK[left];
}

export function parseLicenceRow(
  row: readonly string[],
  context: { sourceUrl: string; fetchedAt: string; asOf: Date },
): LicenceRecord {
  const licenceType = clean(row[FIELD.licenceTypePrefix]);
  const qualifiedBusiness = licenceType === QUALIFIED_BUSINESS_PREFIX;

  const field2 = clean(row[FIELD.individualName]);
  const field3 = clean(row[FIELD.businessName]);

  /**
   * The `QB` split. On a `QB` row field 2 *is* the business name and field 3 is empty; on
   * every other row field 2 is a person and field 3 is the business. Reading one column for
   * both would silently drop the business name of 46.8% of the file.
   */
  const rawBusinessName = qualifiedBusiness ? field2 : field3;
  const businessName =
    rawBusinessName.toUpperCase() === INDIVIDUAL_SENTINEL ? null : orNull(rawBusinessName);

  const primaryStatus = clean(row[FIELD.primaryStatus]);
  const secondaryStatus = orNull(clean(row[FIELD.secondaryStatus]));
  const expirationDate = parseDbprDate(clean(row[FIELD.expirationDate]));

  const standing = deriveStanding({
    primaryStatus,
    secondaryStatus,
    expirationDate,
    licenceType,
    asOf: context.asOf,
  });

  return {
    licenceNumber: orNull(clean(row[FIELD.licenceNumber]).toUpperCase()),
    licenceType,
    qualifiedBusiness,
    licenceClass: orNull(clean(row[FIELD.licenceClass])),
    licenseeName: field2,
    qualifierSurname: qualifiedBusiness ? null : parseSurname(field2),
    businessName,
    city: orNull(clean(row[FIELD.city]).toUpperCase()),
    state: orNull(clean(row[FIELD.state]).toUpperCase()),
    postalCode: orNull(clean(row[FIELD.postalCode])),
    countyCode: orNull(clean(row[FIELD.countyCode])),
    primaryStatus,
    secondaryStatus,
    expirationDate,
    originalLicensureDate: parseDbprDate(clean(row[FIELD.originalLicensureDate])),
    statusEffectiveDate: parseDbprDate(clean(row[FIELD.statusEffectiveDate])),
    standing,
    adverse: isAdverse(standing),
    sourceUrl: context.sourceUrl,
    fetchedAt: context.fetchedAt,
  };
}

/**
 * The most recent date on which Florida construction licences expired en masse.
 *
 * They run on a biennial cycle ending 31 August of even years — the extract bears this out,
 * with 2,287 of the 2,658 expired records sharing the single date `2026-08-31`. Knowing where
 * that boundary falls is what separates "has not renewed yet" from "lapsed through an entire
 * cycle", which are different facts about a contractor.
 */
export function mostRecentRenewalDeadline(asOf: Date): string {
  const year = asOf.getUTCFullYear();
  const passedThisYear = asOf.getTime() >= Date.UTC(year, 7, 31);
  const deadlineYear =
    year % 2 === 0 ? (passedThisYear ? year : year - 2) : year - 1;
  return `${deadlineYear}-08-31`;
}
