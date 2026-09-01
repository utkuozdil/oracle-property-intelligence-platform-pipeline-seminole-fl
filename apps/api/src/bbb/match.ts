/**
 * Joining permit contractor names to harvested BBB businesses.
 *
 * The join is one-directional and best-effort: for each permit contractor name, the
 * highest-scoring BBB business above the confidence floor wins, and everything else about
 * that decision — the tier, the score, how many other candidates also cleared the floor —
 * is written alongside it.
 *
 * Nothing here invents a match. A contractor with no candidate above the floor is emitted
 * with `matched: false` and the score it did reach, which is what makes the reported match
 * rate a measurement rather than a claim.
 */
import { MATCH_CONFIDENCE_FLOOR } from './config';
import type { BbbBusinessRecord, ContractorRatingMatch, MatchTier } from './model';
import {
  nameSurvivedTruncation,
  normalizeBusinessName,
  similarity,
  type NormalizedName,
} from './normalize';

export interface PermitContractor {
  name: string;
  permitCount?: number;
}

function tierFor(score: number, prefixContinuation: boolean): MatchTier {
  if (score >= 1) return 'exact';
  if (prefixContinuation) return 'truncated_prefix';
  if (score >= 0.82) return 'strong';
  return 'weak';
}

interface Candidate {
  record: BbbBusinessRecord;
  /** Primary name first, then every alias. A business is matchable under any of them. */
  names: { raw: string; normalized: NormalizedName }[];
}

/** Pre-normalizes the harvested businesses once, rather than per contractor. */
export function indexBusinesses(records: readonly BbbBusinessRecord[]): Candidate[] {
  return records.map((record) => ({
    record,
    names: [record.businessName, ...record.alsoKnownAs].map((raw) => ({
      raw,
      // A BBB name is never width-truncated, so it is normalized as a complete name.
      normalized: normalizeBusinessName(raw, { truncatedInput: false }),
    })),
  }));
}

export function matchContractor(
  contractor: PermitContractor,
  candidates: readonly Candidate[],
  options: { floor?: number } = {},
): ContractorRatingMatch {
  const floor = options.floor ?? MATCH_CONFIDENCE_FLOOR;
  const truncated = !nameSurvivedTruncation(contractor.name);
  const permit = normalizeBusinessName(contractor.name, { truncatedInput: truncated });

  let best: {
    candidate: Candidate;
    score: number;
    prefixContinuation: boolean;
    matchedName: string;
  } | null = null;
  let aboveFloor = 0;

  for (const candidate of candidates) {
    // A business scores as well as its best-matching name, not as well as its primary one.
    let bestForCandidate: { score: number; prefixContinuation: boolean; raw: string } | null = null;
    for (const name of candidate.names) {
      const { score, prefixContinuation } = similarity(permit, name.normalized);
      if (!bestForCandidate || score > bestForCandidate.score) {
        bestForCandidate = { score, prefixContinuation, raw: name.raw };
      }
    }
    if (!bestForCandidate) continue;
    if (bestForCandidate.score >= floor) aboveFloor += 1;
    if (!best || bestForCandidate.score > best.score) {
      best = {
        candidate,
        score: bestForCandidate.score,
        prefixContinuation: bestForCandidate.prefixContinuation,
        matchedName: bestForCandidate.raw,
      };
    }
  }

  const unmatched: ContractorRatingMatch = {
    permitContractorName: contractor.name,
    permitContractorKey: permit.key,
    permitNameTruncated: truncated,
    permitCount: contractor.permitCount ?? null,
    matched: false,
    matchTier: null,
    confidence: best ? Number(best.score.toFixed(4)) : 0,
    runnerUpCount: 0,
    bbbRecordId: null,
    bbbBusinessName: null,
    bbbMatchedName: null,
    rating: null,
    ratingScore: null,
    accredited: null,
    city: null,
    state: null,
    phones: [],
    profileUrl: null,
    sourceUrl: null,
    fetchedAt: null,
  };

  if (!best || best.score < floor) return unmatched;

  const { record } = best.candidate;
  return {
    ...unmatched,
    matched: true,
    matchTier: tierFor(best.score, best.prefixContinuation),
    confidence: Number(Math.min(best.score, 1).toFixed(4)),
    // The winner is excluded, so this counts genuine competition for the same name.
    runnerUpCount: Math.max(0, aboveFloor - 1),
    bbbRecordId: record.bbbRecordId,
    bbbBusinessName: record.businessName,
    bbbMatchedName: best.matchedName,
    rating: record.rating,
    ratingScore: record.ratingScore,
    accredited: record.accredited,
    city: record.city,
    state: record.state,
    phones: record.phones,
    profileUrl: record.profileUrl,
    sourceUrl: record.sourceUrl,
    fetchedAt: record.fetchedAt,
  };
}

export function matchContractors(
  contractors: readonly PermitContractor[],
  records: readonly BbbBusinessRecord[],
  options: { floor?: number } = {},
): ContractorRatingMatch[] {
  const candidates = indexBusinesses(records);
  return contractors.map((contractor) => matchContractor(contractor, candidates, options));
}

export function matchTierCounts(matches: readonly ContractorRatingMatch[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const match of matches) {
    const key = match.matched ? (match.matchTier as string) : 'unmatched';
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

/**
 * The search term to use when looking a contractor up on BBB.
 *
 * Two adjustments, both because the permit column is not a business name:
 *  - the licence qualifier is dropped, since BBB has never heard of the qualifying agent;
 *  - a truncated name loses its final token, because a fragment like `CONSTRU` matches
 *    nothing while the tokens before it still identify the business.
 */
export function searchTermFor(contractorName: string): string {
  const truncated = !nameSurvivedTruncation(contractorName);
  const normalized = normalizeBusinessName(contractorName, { truncatedInput: truncated });
  let tokens =
    truncated && normalized.tokens.length > 1 ? normalized.tokens.slice(0, -1) : normalized.tokens;
  // Dropping the fragment can leave a dangling conjunction: `ATLANTIC ROOFING AND <CONST>`.
  while (tokens.length > 1 && DANGLING_TOKENS.has(tokens[tokens.length - 1] as string)) {
    tokens = tokens.slice(0, -1);
  }
  return tokens.join(' ');
}

/** Words that cannot end a search term once a truncated fragment is dropped. */
const DANGLING_TOKENS = new Set(['AND', 'OF', 'THE', 'FOR', 'BY']);
