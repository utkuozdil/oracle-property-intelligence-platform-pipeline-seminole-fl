/**
 * Business-name normalization and similarity scoring for the permit -> licence join.
 *
 * A deliberate sibling of `src/bbb/normalize.ts` rather than an import of it. The two tiers
 * match against different right-hand sides — BBB's trade names versus DBPR's registered
 * business and licensee names — and share only a left-hand side. Importing would mean one
 * tier's generic-token list and synonym map silently deciding the other's match rate, and
 * `src/bbb/` is owned by another tier.
 *
 * The rules that survive from that tier are the two it paid for: require a shared
 * *distinctive* token before claiming a name match, and treat a 30-character permit name as
 * a character prefix rather than a token bag.
 */

/** Entity-type suffixes, dropped before comparison. They identify nothing. */
const ENTITY_SUFFIXES = new Set([
  'INC',
  'INCORPORATED',
  'LLC',
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

const LEADING_NOISE = new Set(['THE']);

/**
 * Abbreviation expansions, kept deliberately small.
 *
 * Every entry is a licence taken with the operator's data, and a generous synonym list is
 * the fastest way to manufacture matches that are not real. All of these are abbreviations
 * observed in the permit column itself — `ADCOCK & ADCOCK CONSTR INC`, `FLEMING BROS ROOFING
 * CO INC`, `E H ENGELMEIER ROOF & S/M CO`.
 *
 * `ROOF` is deliberately absent: unlike the rest it is a real word, and businesses use both
 * forms as their actual name — `Nations Roof Residential` is not `Nations Roofing
 * Residential`. The bigram score already treats the two as close, which is the right
 * strength of evidence for a guess.
 */
const SYNONYMS = new Map<string, string>([
  ['CONST', 'CONSTRUCTION'],
  ['CONSTR', 'CONSTRUCTION'],
  ['CONSTRUC', 'CONSTRUCTION'],
  ['MAINT', 'MAINTENANCE'],
  ['BROS', 'BROTHERS'],
  ['SVCS', 'SERVICES'],
  ['SVC', 'SERVICE'],
  ['RFG', 'ROOFING'],
]);

/**
 * Industry words that identify no particular business.
 *
 * Used only to gate the containment and overlap rules: every roofing company in the county
 * shares these tokens, so agreement on them alone is evidence that both parties are roofers,
 * not evidence that they are the same roofer.
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
  'BUILD',
  'SOLAR',
  'HOME',
  'HOMES',
  'SERVICES',
  'SERVICE',
  'MAINTENANCE',
  'RESTORATION',
  'REMODELING',
  'EXTERIORS',
  /**
   * Singular included after the plural alone let `THE EXTERIOR COMPANY INC` match `EXTERIOR
   * HOMESAVERS INC` at 0.875 on `EXTERIOR` as its one "distinctive" token, over 13 other
   * candidates. Trade vocabulary is generic in both numbers.
   */
  'EXTERIOR',
  'SPECIALISTS',
  'SOLUTIONS',
  'SYSTEMS',
  'ASSOCIATES',
  'GROUP',
  'ENTERPRISES',
  'FLORIDA',
  'FL',
  'CENTRAL',
  'OF',
  'AND',
  'SONS',
]);

export interface NormalizedName {
  /** Space-separated normalized tokens. The human-readable key. */
  key: string;
  /** `key` with spaces removed, for prefix comparison of truncated names. */
  compact: string;
  tokens: string[];
  truncated: boolean;
}

export function normalizeBusinessName(
  raw: string,
  options: { truncatedInput?: boolean } = {},
): NormalizedName {
  const truncated = options.truncatedInput ?? false;

  const cleaned = raw
    .toUpperCase()
    .replace(/&/g, ' AND ')
    .replace(/\+/g, ' AND ')
    // Possessives collapse rather than split: `MCFADDEN'S` -> `MCFADDENS`.
    .replace(/[’']/g, '')
    .replace(/[^A-Z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  /**
   * A trailing legal-form *phrase*, which the single-token suffix list cannot reach.
   *
   * `BALFOUR BEATTY CONSTRUCTION/ALEXANDER GROUP, A JOINT VENTURE` ends in a description of
   * how the entity is organised, not in its name, and leaving it on made `VENTURE` an
   * apparently distinctive token — enough to claim that entity for the unrelated `VENTURE
   * CONSTRUCTION GROUP` at 0.86. Stripped as a phrase so that a company genuinely called
   * `Venture` keeps its token.
   */
  const withoutLegalForm = cleaned.replace(/\s+A?\s*JOINT VENTURE$/, '');

  let tokens = withoutLegalForm.length > 0 ? withoutLegalForm.split(' ') : [];

  while (tokens.length > 1 && LEADING_NOISE.has(tokens[0] as string)) tokens = tokens.slice(1);

  /**
   * Suffixes are stripped from the tail only, and never down to nothing. A trailing `CO` in
   * `TIP TOP ROOFING CO` is noise; the same token inside a name is not.
   */
  while (tokens.length > 1 && ENTITY_SUFFIXES.has(tokens[tokens.length - 1] as string)) {
    tokens = tokens.slice(0, -1);
  }

  /**
   * A truncated name's final token may be a fragment (`CONSTRU`, `PROFES`). Expanding it
   * through the synonym map would be a guess about which word it was becoming.
   */
  tokens = tokens.map((token, index) => {
    if (truncated && index === tokens.length - 1) return token;
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
 * Ceiling for a candidate whose only agreement is industry vocabulary. Deliberately below
 * `MATCH_CONFIDENCE_FLOOR`, so such a candidate can never be claimed as a match while the
 * unmatched report still shows how close it came.
 */
const GENERIC_ONLY_SCORE_CAP = 0.5;

export function similarity(permit: NormalizedName, candidate: NormalizedName): Similarity {
  if (permit.compact.length === 0 || candidate.compact.length === 0) {
    return { score: 0, prefixContinuation: false };
  }

  if (permit.key === candidate.key) return { score: 1, prefixContinuation: false };

  if (permit.truncated && candidate.compact.startsWith(permit.compact)) {
    /**
     * Scored just below exact and shaded by how much of the candidate the prefix covers, so
     * a two-token prefix does not match a great many businesses at the same confidence as a
     * nine-token one.
     */
    const coverage = permit.compact.length / candidate.compact.length;
    return { score: 0.9 + 0.09 * coverage, prefixContinuation: true };
  }

  const distinctive = permit.tokens.filter((token) => !GENERIC_TOKENS.has(token));

  /**
   * Containment: every permit token appears in the candidate, which is what a business that
   * has added a line of work to its name looks like. Gated on a distinctive token, since
   * `ROOFING AND CONSTRUCTION` is contained in a great many county roofers and identifies
   * none of them.
   */
  if (distinctive.length > 0 && permit.tokens.every((token) => candidate.tokens.includes(token))) {
    const coverage = permit.tokens.length / candidate.tokens.length;
    return { score: Math.min(0.99, 0.8 + 0.15 * coverage), prefixContinuation: false };
  }

  const tokenScore = tokenSetDice(permit.tokens, candidate.tokens);
  const charScore = bigramDice(permit.compact, candidate.compact);
  /**
   * Token agreement outweighs character agreement: two unrelated roofing companies share a
   * great many bigrams simply by both being roofing companies.
   */
  const blended = 0.65 * tokenScore + 0.35 * charScore;

  /**
   * The distinctive-token gate — the single most important rule here for not lying.
   *
   * The BBB tier measured what happens without it: the blended score cleared the floor on
   * overlap made up *entirely* of industry vocabulary, and three of the matches it produced
   * were wrong about a real, named business (`BLITZ ROOFING & CONSTRUCTION` claimed as "HC
   * Roofing & Construction", and so on). Requiring one shared token that actually names the
   * business dropped all three and kept the true positive in that group.
   *
   * The score is capped rather than zeroed so the unmatched report stays informative.
   */
  const candidateTokens = new Set(candidate.tokens);
  const sharedDistinctive = distinctive.some((token) => candidateTokens.has(token));
  if (!sharedDistinctive) {
    return { score: Math.min(blended, GENERIC_ONLY_SCORE_CAP), prefixContinuation: false };
  }

  return { score: blended, prefixContinuation: false };
}

/** Whether a token names a particular business rather than the trade in general. */
export function isDistinctiveToken(token: string): boolean {
  return !GENERIC_TOKENS.has(token);
}
