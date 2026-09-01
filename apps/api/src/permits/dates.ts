/**
 * Two-digit year resolution, shared by both sources because both render `MM/DD/YY`.
 *
 * Both sources previously pivoted on the 1996 Source A horizon, which is correct only for
 * Source A. Source B is looked up by application number rather than by issue date, so it
 * reaches permits Source A's index does not: `84-00001` is a real 1984 permit. Under the
 * horizon pivot its date read as 2084, which made a 42-year-old permit look like a future
 * one and its open duration negative.
 */

/**
 * The century a two-digit year belongs to.
 *
 * The rule is "a permit cannot have been issued in the future". A two-digit year is read as
 * 20xx unless that lands beyond next year, in which case it is 19xx. One year of slack
 * absorbs a clock skew or a genuinely post-dated record without reinterpreting the century.
 *
 * This is deliberately not a fixed pivot such as 50. A fixed pivot has to be revisited as
 * the window moves, and the failure is silent when it stops being right.
 */
export function resolveTwoDigitYear(twoDigit: number, referenceYear: number): number {
  const asThisCentury = 2000 + twoDigit;
  return asThisCentury > referenceYear + 1 ? 1900 + twoDigit : asThisCentury;
}

/**
 * `MM/DD/YY` or `MM/DD/YYYY` to an ISO date, or null when it is neither.
 *
 * Returns null rather than a guess for anything unparseable, because a wrong date here
 * becomes a wrong open duration, which is the signal the whole tier exists to produce.
 */
export function parseUsDate(raw: string, referenceYear = new Date().getUTCFullYear()): string | null {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(raw.trim());
  if (!match) return null;
  const [, month, day, yearPart] = match as unknown as [string, string, string, string];
  const year =
    yearPart.length === 4
      ? Number(yearPart)
      : resolveTwoDigitYear(Number(yearPart), referenceYear);

  const monthIndex = Number(month);
  const dayOfMonth = Number(day);
  const iso = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  const parsed = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  // `Date` rolls 02/31 forward into March rather than rejecting it, so the round-trip is
  // what actually validates the day-of-month.
  if (parsed.getUTCMonth() + 1 !== monthIndex || parsed.getUTCDate() !== dayOfMonth) return null;
  return iso;
}
