/**
 * Parsing the licence-qualifier parenthetical off a permit contractor name.
 *
 * This file is where this tier earns its keep. The BBB tier had to match permit contractor
 * names to business names by similarity alone, and documented the cost of that honestly.
 * The permit portal, though, appends the *qualifying agent's surname* and their *licence-type
 * prefix* to the contractor name, and occasionally the licence serial outright — and DBPR
 * publishes exactly those three things per licence. So most of this join can be a keyed
 * lookup rather than a guess.
 *
 * Measured on the real census (1,165 distinct roofing-relevant contractor names): 208 names
 * carry a parenthetical, and `CCC` — the Florida certified-roofing prefix — is the single
 * most common content at 80 of them. The forms actually observed, all of which are handled
 * below:
 *
 *   COLLIS (LANIER)                  surname only, closed
 *   JTO CONTRACTING INC (HOOD CCC)   surname + prefix, space separated
 *   COLLIS ROOFING INC (LANIER-CCC   surname + prefix, hyphenated, cut by the 30-char column
 *   ALL PRO CONTRACTING(CCC-ARNOLD   prefix first, no space before the paren
 *   CAPSTONE CONSTRUCTION (CCC)      prefix only, no surname
 *   LUNDBERG, DAVID C (1325941)      licence serial outright
 *   NOLANDS ROOFING (CCC-1335461)    prefix + licence serial
 *   SOLAR ROOFING AND CONST(CCC)RU   spliced into the middle of a word
 *   JANNEY ROOFING LLC (CCC-HARRIS   surname itself truncated by the column
 */
import { PERMIT_CONTRACTOR_NAME_MAX_LENGTH } from './config';

export interface ParsedContractorName {
  /** The name with the qualifier parenthetical removed. May still be width-truncated. */
  businessPart: string;
  /** Qualifying agent's surname, uppercased and stripped to letters. */
  surname: string | null;
  /**
   * True when the parenthetical was left unclosed by the 30-character column *and* the
   * surname was its last token, so the surname may itself be a fragment — `CCC-DIA`,
   * `CCC-REVE`, `RC MICHA`. Such a surname is compared as a prefix, never as an equality.
   */
  surnameTruncated: boolean;
  /** Licence-type prefix (`CCC`, `CGC`, `CRC`, ...) when the parenthetical named one. */
  licencePrefix: string | null;
  /** Licence serial digits when the parenthetical carried them. */
  licenceSerial: string | null;
  /** Whether any parenthetical was found at all. */
  hasQualifier: boolean;
}

/**
 * Removes the qualifier parenthetical from a name, closing up a mid-word splice.
 *
 * `SOLAR ROOFING AND CONST(CCC)RU` is `...CONSTRU` interrupted by a licence code, not a
 * `CONST` token followed by an `RU` token. Replacing it with a space manufactures a
 * meaningless `CONST RU`; deleting it recovers the `CONSTRU` prefix the real name has.
 * Balanced groups are handled before the unclosed tail so that a name carrying both keeps
 * as much of itself as possible.
 */
export function stripQualifier(value: string): string {
  return value
    .replace(/(?<=\S)\([^()]*\)(?=\S)/g, '')
    .replace(/\([^()]*\)/g, ' ')
    .replace(/\([^()]*$/, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Digits that could be a licence serial. Serials in the extract are 5 to 8 digits. */
const SERIAL_PATTERN = /^0*(\d{5,8})$/;

/**
 * Parses a permit contractor name.
 *
 * `licencePrefixes` is supplied by the caller from the licence data actually loaded — 29
 * distinct prefixes statewide — rather than hardcoded here, so a new DBPR licence type
 * starts being recognised as a prefix rather than being misread as a surname.
 */
export function parseContractorName(
  raw: string,
  licencePrefixes: ReadonlySet<string>,
): ParsedContractorName {
  const trimmed = raw.trim();
  const businessPart = stripQualifier(trimmed);

  // The *last* parenthetical is the qualifier; an earlier one belongs to the business name.
  const closed = [...trimmed.matchAll(/\(([^()]*)\)/g)];
  const unclosed = /\(([^()]*)$/.exec(trimmed);

  let inner: string | null = null;
  let innerTruncated = false;
  if (unclosed && (closed.length === 0 || unclosed.index > (closed.at(-1)?.index ?? -1))) {
    inner = unclosed[1] ?? '';
    /**
     * Only a name the column actually cut can have lost characters. A short name with an
     * unbalanced paren is somebody's typo, and its last token is complete.
     */
    innerTruncated = trimmed.length >= PERMIT_CONTRACTOR_NAME_MAX_LENGTH;
  } else if (closed.length > 0) {
    inner = closed.at(-1)?.[1] ?? '';
  }

  if (inner === null) {
    return {
      businessPart,
      surname: null,
      surnameTruncated: false,
      licencePrefix: null,
      licenceSerial: null,
      hasQualifier: false,
    };
  }

  const tokens = inner
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter((token) => token.length > 0);

  let licencePrefix: string | null = null;
  let licenceSerial: string | null = null;
  let surname: string | null = null;
  let surnameIsLastToken = false;

  for (const [index, token] of tokens.entries()) {
    const serial = SERIAL_PATTERN.exec(token);
    if (serial) {
      licenceSerial ??= serial[1] as string;
      continue;
    }
    if (licencePrefixes.has(token)) {
      licencePrefix ??= token;
      continue;
    }
    /**
     * A two-character residue is not a usable surname. `(CC)`, `(JA)`, `(QR)` and `(JO)`
     * all occur in the census and are prefixes or given-name initials cut by the column;
     * matching a surname on two letters would return dozens of licensees.
     */
    if (token.length >= 3 && surname === null) {
      surname = token.replace(/[^A-Z]/g, '');
      surnameIsLastToken = index === tokens.length - 1;
    }
  }

  return {
    businessPart,
    surname: surname !== null && surname.length >= 3 ? surname : null,
    surnameTruncated: innerTruncated && surnameIsLastToken,
    licencePrefix,
    licenceSerial,
    hasQualifier: true,
  };
}

/**
 * Whether a 30-character permit name lost part of its *business name* as opposed to part of
 * its licence qualifier.
 *
 * Carried over from the BBB tier's hard-won lesson, and it does most of the work in the
 * name-similarity path. A name is only truncated in the sense that matters if the cut landed
 * inside the name itself:
 *
 *   NATIONS ROOF RESIDENTIAL LLC(B   cut inside an unclosed qualifier -> name complete
 *   COLLIS ROOFING INC (LANIER-CCC   cut inside an unclosed qualifier -> name complete
 *   JTO CONTRACTING INC (HOOD CCC)   qualifier closed at the cut      -> name complete
 *   SOLAR ROOFING AND CONST(CCC)RU   cut after a closed qualifier     -> name cut
 *   LM ROOFING AND CONSTRUCTION CO   no qualifier at all              -> name cut
 *
 * Treating every 30-character name as cut is what made `NATIONS ROOF RESIDENTIAL LLC(B`
 * search for `NATIONS ROOFING`, dropping the one token that identified the business.
 */
export function nameSurvivedTruncation(raw: string): boolean {
  const trimmed = raw.trim();
  if (trimmed.length < PERMIT_CONTRACTOR_NAME_MAX_LENGTH) return true;
  if (trimmed.endsWith(')')) return true;
  const lastOpen = trimmed.lastIndexOf('(');
  const lastClose = trimmed.lastIndexOf(')');
  return lastOpen > lastClose;
}

/**
 * Whether a permit name is written as an individual rather than a business.
 *
 * DBPR writes licensees `LAST, FIRST M` and the permit portal does the same for
 * owner-operators — `MCFADDEN, RICHARD DAVID`, `SENEZ, ISAAC EDMOND`. That shared convention
 * is a keyed join the BBB tier could not have: BBB lists businesses, not licensed
 * individuals.
 *
 * The entity-suffix check keeps `PARKER ROOFS, LLC` out; its comma is punctuation in a
 * business name, and it belongs in the business-name path where DBPR's `QB` rows hold it.
 */
const ENTITY_SUFFIX_PATTERN = /\b(INC|LLC|CORP|CO|COMPANY|LTD|LP|LLP|PA|PLLC)\b\.?\s*$/;

export function looksLikeIndividual(raw: string): boolean {
  const withoutQualifier = stripQualifier(raw).trim();
  if (!withoutQualifier.includes(',')) return false;
  return !ENTITY_SUFFIX_PATTERN.test(withoutQualifier.toUpperCase());
}

/** Splits `LAST, FIRST M` into a comparable surname and given name. */
export function parsePersonName(raw: string): { surname: string; given: string } | null {
  const withoutQualifier = stripQualifier(raw).toUpperCase();
  const comma = withoutQualifier.indexOf(',');
  if (comma < 0) return null;
  const surname = withoutQualifier.slice(0, comma).replace(/[^A-Z]/g, '');
  const rest = withoutQualifier
    .slice(comma + 1)
    .split(/[^A-Z]+/)
    .filter((token) => token.length > 0);
  const given = rest[0] ?? '';
  if (surname.length === 0 || given.length === 0) return null;
  return { surname, given };
}
