/**
 * Business-name normalization and similarity scoring for the permit -> BBB join.
 *
 * This join is fuzzy and will never be perfect. The design goal is therefore not a high
 * match rate but a *defensible* one: every match carries a tier and a score, and anything
 * that cannot clear the floor is recorded as unmatched with its best candidate attached
 * rather than being quietly promoted.
 *
 * Two properties of the permit portal's contractor column drive almost all of the
 * difficulty, and both were measured off the permit fixtures rather than assumed:
 *
 *  1. The column is 30 characters wide and truncates mid-word with no ellipsis. 13 of the
 *     47 distinct names are exactly 30 characters — `SOLAR ROOFING AND CONST(CCC)RU`,
 *     `FLEMING BROTHERS ROOF(RC MICHA`. Token-based comparison cannot match a name whose
 *     last token is a fragment, so truncated names are compared as character prefixes.
 *  2. Names carry a licence-qualifier parenthetical that is not part of the business name —
 *     `(CCC)`, `(CCC-ANGIULLI)`, `(HOOD CCC)`, `(LANIER-CCC`. `CCC` is the Florida
 *     certified-roofing licence prefix and the trailing name is the qualifying agent.
 *     Truncation frequently leaves these unbalanced, so an unclosed `(` is stripped too.
 */
import { PERMIT_CONTRACTOR_NAME_MAX_LENGTH } from './config';

/**
 * Entity-type suffixes, dropped before comparison.
 *
 * `Inc`/`LLC` and friends carry no identifying information and are recorded
 * inconsistently on both sides — the permit portal writes `LLC` with no comma and BBB
 * writes `, LLC`.
 */
const ENTITY_SUFFIXES = new Set([
  'INC',
  'INCORPORATED',
  'LLC',
  'LLC.',
  'LC',
  'LLP',
  'LLLP',
  'LP',
  'PA',
  'PLLC',
  'PL',
  'CO',
  'CORP',
  'CORPORATION',
  'COMPANY',
  'LTD',
  'LIMITED',
]);

/** Leading noise words, dropped only when leading. */
const LEADING_NOISE = new Set(['THE']);

/**
 * Word-level synonyms, applied after suffix stripping.
 *
 * Kept deliberately tiny. Every entry is a licence the matcher takes with the operator's
 * data, and a generous synonym list is the fastest way to manufacture matches that are not
 * real. These are abbreviations observed in the permit column itself.
 */
const SYNONYMS = new Map<string, string>([
  ['CONST', 'CONSTRUCTION'],
  ['CONSTR', 'CONSTRUCTION'],
  ['MAINT', 'MAINTENANCE'],
  ['BROS', 'BROTHERS'],
  ['SVCS', 'SERVICES'],
  ['SVC', 'SERVICE'],
  ['RFG', 'ROOFING'],
]);

/**
 * `ROOF` is deliberately *not* a synonym for `ROOFING`.
 *
 * Every other entry above is an abbreviation that is not a word. `ROOF` is a word, and
 * businesses use both forms as their actual name — `Nations Roof Residential` is not
 * `Nations Roofing Residential`. Expanding it turned a would-be exact match into a miss,
 * measured on the permit fixtures. The bigram score already treats the two as close,
 * which is the right strength of evidence for a guess.
 */

/**
 * Industry words that identify no particular business.
 *
 * Used only to stop the containment rule below from matching on generic overlap: every
 * roofing company in the county shares these tokens.
 */
const GENERIC_TOKENS = new Set([
  'ROOFING',
  'ROOF',
  'ROOFS',
  'CONSTRUCTION',
  'CONTRACTING',
  'CONTRACTORS',
  'CONTRACTOR',
  'BUILDERS',
  'BUILDING',
  'SOLAR',
  'HOME',
  'HOMES',
  'SERVICES',
  'SERVICE',
  'MAINTENANCE',
  'RESTORATION',
  'EXTERIORS',
  'SPECIALISTS',
  'SOLUTIONS',
  'ASSOCIATES',
  'GROUP',
  'FLORIDA',
  'FL',
  'CENTRAL',
  'OF',
  'AND',
]);

export interface NormalizedName {
  /** Space-separated normalized tokens. The human-readable key. */
  key: string;
  /** `key` with spaces removed. Used for prefix comparison of truncated names. */
  compact: string;
  tokens: string[];
  /** Whether the permit portal's 30-character column cut the business name itself. */
  truncated: boolean;
}

/**
 * Removes licence-qualifier parentheticals, including one left unclosed by truncation.
 *
 * Ordering matters: balanced groups go first, so `ATLANTIC ROOFING & (CCC) CONST` loses
 * only the qualifier, and the unclosed-tail rule then catches `NATIONS ROOF RESIDENTIAL
 * LLC(B` without eating the whole name.
 */
export function stripLicenceQualifiers(value: string): string {
  return (
    value
      /**
       * A qualifier spliced into the middle of a word, with no space on either side, is
       * removed by closing the word back up rather than by splitting it in two.
       *
       * `SOLAR ROOFING AND CONST(CCC)RU` is `...CONSTRU` interrupted by the licence code, not
       * a `CONST` token and an `RU` token. Replacing it with a space produced a bogus
       * `CONSTRUCTION RU`, which matched nothing; closing it up produces the `CONSTRU` prefix
       * the real name actually starts with.
       */
      .replace(/(?<=\S)\([^()]*\)(?=\S)/g, '')
      .replace(/\([^()]*\)/g, ' ')
      .replace(/\([^()]*$/, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/**
 * Whether a 30-character permit name lost part of its *business name*, as opposed to part
 * of its licence qualifier.
 *
 * This distinction does most of the work in this file. A name is only truncated in the sense
 * that matters if the cut landed inside the name itself:
 *
 *   `NATIONS ROOF RESIDENTIAL LLC(B`   cut inside an unclosed qualifier -> name is complete
 *   `COLLIS ROOFING INC (LANIER-CCC`   cut inside an unclosed qualifier -> name is complete
 *   `JTO CONTRACTING INC (HOOD CCC)`   qualifier closed at the cut      -> name is complete
 *   `SOLAR ROOFING AND CONST(CCC)RU`   cut after a closed qualifier     -> name is cut
 *   `LM ROOFING AND CONSTRUCTION CO`   no qualifier at all              -> name is cut
 *
 * Treating all 30-character names as cut is what made `NATIONS ROOF RESIDENTIAL LLC(B`
 * search BBB for `NATIONS ROOFING` — it dropped `RESIDENTIAL`, the one token that
 * identified the business, from a name that was never truncated to begin with.
 */
export function nameSurvivedTruncation(raw: string): boolean {
  const trimmed = raw.trim();
  if (trimmed.length < PERMIT_CONTRACTOR_NAME_MAX_LENGTH) return true;
  // The qualifier closed before the cut, so nothing after it was lost.
  if (trimmed.endsWith(')')) return true;
  // An unclosed `(` means everything from it onward is qualifier, and the name ended earlier.
  const lastOpen = trimmed.lastIndexOf('(');
  const lastClose = trimmed.lastIndexOf(')');
  return lastOpen > lastClose;
}

/**
 * Normalizes a business name to a comparison key.
 *
 * `truncatedInput` can be passed explicitly, because only the caller knows whether the
 * string came from the width-limited permit column or from BBB's JSON — a 30-character BBB
 * name is just a 30-character name. Left unset, truncation is inferred.
 */
export function normalizeBusinessName(
  raw: string,
  options: { truncatedInput?: boolean } = {},
): NormalizedName {
  const truncated = options.truncatedInput ?? !nameSurvivedTruncation(raw);

  const withoutQualifiers = stripLicenceQualifiers(raw);

  const cleaned = withoutQualifiers
    .toUpperCase()
    .replace(/&/g, ' AND ')
    .replace(/\+/g, ' AND ')
    // Possessives collapse rather than split: `MCFADDEN'S` -> `MCFADDENS`.
    .replace(/[’']/g, '')
    .replace(/[^A-Z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  let tokens = cleaned.length > 0 ? cleaned.split(' ') : [];

  while (tokens.length > 1 && LEADING_NOISE.has(tokens[0] as string)) tokens = tokens.slice(1);

  /**
   * Suffixes are stripped from the tail only, and never down to nothing. A trailing `CO`
   * in `TIP TOP ROOFING CO` is noise; the same token inside a name is not.
   */
  while (tokens.length > 1 && ENTITY_SUFFIXES.has(tokens[tokens.length - 1] as string)) {
    tokens = tokens.slice(0, -1);
  }

  /**
   * A truncated name's final token may be a fragment (`CONSTRU`, `MICHA`). Expanding it
   * through the synonym map would be a guess, so expansion is skipped for that one token.
   */
  tokens = tokens.map((token, index) => {
    const isTrailingFragment = truncated && index === tokens.length - 1;
    if (isTrailingFragment) return token;
    return SYNONYMS.get(token) ?? token;
  });

  const key = tokens.join(' ');
  return { key, compact: key.replace(/ /g, ''), tokens, truncated };
}

/** Dice coefficient over token sets. Symmetric, and forgiving of word order. */
export function tokenSetDice(left: readonly string[], right: readonly string[]): number {
  if (left.length === 0 || right.length === 0) return 0;
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  let shared = 0;
  for (const token of leftSet) if (rightSet.has(token)) shared += 1;
  return (2 * shared) / (leftSet.size + rightSet.size);
}

/** Dice coefficient over character bigrams. Catches typos and fragment tokens. */
export function bigramDice(left: string, right: string): number {
  if (left.length < 2 || right.length < 2) return left === right ? 1 : 0;
  const bigrams = (value: string): Map<string, number> => {
    const counts = new Map<string, number>();
    for (let index = 0; index < value.length - 1; index += 1) {
      const gram = value.slice(index, index + 2);
      counts.set(gram, (counts.get(gram) ?? 0) + 1);
    }
    return counts;
  };
  const leftGrams = bigrams(left);
  const rightGrams = bigrams(right);
  let shared = 0;
  let leftTotal = 0;
  let rightTotal = 0;
  for (const count of leftGrams.values()) leftTotal += count;
  for (const [gram, count] of rightGrams) {
    rightTotal += count;
    shared += Math.min(count, leftGrams.get(gram) ?? 0);
  }
  return (2 * shared) / (leftTotal + rightTotal);
}

export interface Similarity {
  score: number;
  /** True when the candidate continues a truncated permit name character-for-character. */
  prefixContinuation: boolean;
}

/**
 * Scores a permit contractor name against a BBB business name.
 *
 * Truncated names are handled first and separately. A permit name cut at 30 characters is
 * a *prefix* of the truth, so a candidate that continues it exactly is far better evidence
 * than any token overlap — and token overlap actively penalises it, because the BBB name
 * has tokens the permit name could not have contained.
 */
export function similarity(permit: NormalizedName, candidate: NormalizedName): Similarity {
  if (permit.compact.length === 0 || candidate.compact.length === 0) {
    return { score: 0, prefixContinuation: false };
  }

  if (permit.key === candidate.key) return { score: 1, prefixContinuation: false };

  if (permit.truncated && candidate.compact.startsWith(permit.compact)) {
    /**
     * Scored just below exact, and shaded by how much of the candidate the prefix covers,
     * so `LM ROOFING AND CONSTRUCTION CO` continuing into a much longer name scores lower
     * than one it nearly spans. A two-token prefix would otherwise match a great many
     * businesses at the same confidence as a nine-token one.
     */
    const coverage = permit.compact.length / candidate.compact.length;
    return { score: 0.9 + 0.09 * coverage, prefixContinuation: true };
  }

  /**
   * Containment: every permit token appears in the candidate, which is what a business that
   * has added a line of work to its name looks like — `3MG ROOFING` against
   * `3MG Roofing & Solar`. Token overlap alone scores that at 0.68 and calls it weak,
   * because it penalises the candidate for tokens the permit column never claimed to have.
   *
   * Guarded on a distinctive token, since `ROOFING AND CONSTRUCTION` is contained in a
   * great many county roofers and identifies none of them.
   */
  const distinctive = permit.tokens.filter((token) => !GENERIC_TOKENS.has(token));
  if (distinctive.length > 0 && permit.tokens.every((token) => candidate.tokens.includes(token))) {
    const coverage = permit.tokens.length / candidate.tokens.length;
    return { score: Math.min(0.99, 0.8 + 0.15 * coverage), prefixContinuation: false };
  }

  const tokenScore = tokenSetDice(permit.tokens, candidate.tokens);
  const charScore = bigramDice(permit.compact, candidate.compact);
  /**
   * Token agreement is weighted higher than character agreement: two unrelated roofing
   * companies share a great many bigrams simply by both being roofing companies.
   */
  const blended = 0.65 * tokenScore + 0.35 * charScore;

  /**
   * The distinctive-token gate, and the single most important rule here for not lying.
   *
   * Without it the blended score cleared the 0.6 floor on overlap made up *entirely* of
   * industry vocabulary, and three of the five matches it produced on the permit fixtures
   * were wrong about a real business:
   *
   *   BLITZ ROOFING & CONSTRUCTION  -> "HC Roofing & Construction"   (0.79)
   *   GREENTEK ROOFING & SOLAR      -> "JTO Roofing and Solar"       (0.74)
   *   BARBER & ASSOCIATES INC       -> "Crespo & Associates"         (0.67)
   *
   * Each shares only words like `ROOFING`, `SOLAR`, `ASSOCIATES` — which is evidence that
   * both are roofing companies, not evidence that they are the same one. Requiring one
   * shared token that actually names the business kept the true positive in that group
   * (`FLEMING BROTHERS ROOF` -> `Fleming Brothers Roofing`) and dropped all three errors.
   *
   * The score is capped rather than zeroed, so the unmatched report still shows how close
   * the best candidate came.
   */
  const candidateTokens = new Set(candidate.tokens);
  const sharedDistinctive = permit.tokens.some(
    (token) => !GENERIC_TOKENS.has(token) && candidateTokens.has(token),
  );
  if (!sharedDistinctive) {
    return { score: Math.min(blended, GENERIC_ONLY_SCORE_CAP), prefixContinuation: false };
  }

  return { score: blended, prefixContinuation: false };
}

/**
 * Ceiling for a candidate whose only agreement is industry vocabulary. Deliberately below
 * `MATCH_CONFIDENCE_FLOOR`, so such a candidate can never be claimed as a match.
 */
const GENERIC_ONLY_SCORE_CAP = 0.5;
