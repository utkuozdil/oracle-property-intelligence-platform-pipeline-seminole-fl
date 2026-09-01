/**
 * Joining Overture roofing businesses to permit contractors and to BBB ratings.
 *
 * The chain is two fuzzy hops:
 *
 *     Overture roofing place  --name-->  permit contractor  --name-->  BBB business
 *
 * Neither hop has an identifier in common. Overture has no licence number, the permit portal
 * has no registry key, and BBB has neither. So this is a name match, and the only honest
 * design is one that reports how good each hop was and never presents the result as a
 * lookup. Both scores travel on every output row.
 *
 * ## Why this reuses the BBB tier's matcher
 *
 * `normalizeBusinessName` and `similarity` are imported from `../bbb/normalize` rather than
 * reimplemented. That is a read-only dependency on another tier's module, taken deliberately:
 * that matcher already encodes two things measured off the real permit column — the 30-
 * character truncation and the `(CCC)` licence-qualifier parenthetical — and a second matcher
 * here would inevitably disagree with it. Two tiers reporting different match rates for the
 * same pair of names is worse than a coupling.
 *
 * Nothing in `src/bbb/` is modified by this module.
 */
import { MATCH_CONFIDENCE_FLOOR } from '../bbb/config';
import type { BbbBusinessRecord, ContractorRatingMatch } from '../bbb/model';
import { normalizeBusinessName, similarity, type NormalizedName } from '../bbb/normalize';
import type { RoofingBusinessMatch, RoofingJoinSummary } from './model';
import type { RoofingRow } from './extract';

/** A permit contractor name and how many permits carried it. */
export interface PermitContractorName {
  name: string;
  permitCount?: number;
}

export interface RoofingJoinInput {
  release: string;
  roofingRows: readonly RoofingRow[];
  permitContractors: readonly PermitContractorName[];
  /** Harvested BBB businesses. Empty is valid and produces a measured zero, not a guess. */
  bbbBusinesses?: readonly BbbBusinessRecord[];
  /** The BBB tier's own permit-contractor -> BBB join, when its run output is available. */
  contractorRatings?: readonly ContractorRatingMatch[];
  floor?: number;
  /** Named in the summary so a rate is never read without its denominator's origin. */
  permitContractorSource: string;
  bbbBusinessSource: string;
}

interface Indexed<T> {
  value: T;
  normalized: NormalizedName;
}

function tierFor(score: number, prefixContinuation: boolean): string {
  if (score >= 1) return 'exact';
  if (prefixContinuation) return 'truncated_prefix';
  if (score >= 0.82) return 'strong';
  return 'weak';
}

/**
 * The tiers this join is willing to quote as a match rate.
 *
 * `weak` is excluded on evidence, not on principle. Inspecting all seven weak matches from
 * the 2026-08-19.0 run, three were plainly different companies that happen to share roofing
 * vocabulary. The rows are still emitted with their tier and score attached — a consumer that
 * wants recall can take them — but the headline number does not include them.
 */
export const DEFENSIBLE_TIERS: readonly string[] = ['exact', 'truncated_prefix', 'strong'];

/**
 * Best candidate for one place name among a set of normalized candidates.
 *
 * The direction matters. A permit contractor name may be truncated, an Overture name never
 * is, so the truncated side has to be the left operand of `similarity` for its prefix rule
 * to fire. Scoring an Overture name *as* the truncated side would silently disable the tier
 * that matches the hardest cases.
 */
function bestMatch<T>(
  place: NormalizedName,
  candidates: readonly Indexed<T>[],
  floor: number,
  candidateIsTruncatable: boolean,
): { value: T; score: number; tier: string; aboveFloor: number } | null {
  let best: { value: T; score: number; prefix: boolean } | null = null;
  let aboveFloor = 0;

  for (const candidate of candidates) {
    const { score, prefixContinuation } = candidateIsTruncatable
      ? similarity(candidate.normalized, place)
      : similarity(place, candidate.normalized);
    if (score >= floor) aboveFloor += 1;
    if (!best || score > best.score) {
      best = { value: candidate.value, score, prefix: prefixContinuation };
    }
  }

  if (!best || best.score < floor) return null;
  return {
    value: best.value,
    score: Number(Math.min(best.score, 1).toFixed(4)),
    tier: tierFor(best.score, best.prefix),
    aboveFloor,
  };
}

/**
 * Joins roofing places outward to permits and to BBB.
 *
 * BBB is reached two ways and the path is recorded. A `direct` match is the Overture name
 * against a harvested BBB business. A `via_permit_contractor` match is the BBB tier's own
 * join, reached through the permit contractor this place matched — which is strictly weaker,
 * because it compounds two fuzzy scores, and is reported as its own path for that reason.
 */
export function joinRoofingBusinesses(input: RoofingJoinInput): {
  matches: RoofingBusinessMatch[];
  summary: RoofingJoinSummary;
} {
  const floor = input.floor ?? MATCH_CONFIDENCE_FLOOR;

  const permitIndex: Indexed<PermitContractorName>[] = input.permitContractors.map((value) => ({
    value,
    normalized: normalizeBusinessName(value.name),
  }));

  const bbbIndex: Indexed<BbbBusinessRecord>[] = (input.bbbBusinesses ?? []).map((value) => ({
    value,
    normalized: normalizeBusinessName(value.businessName, { truncatedInput: false }),
  }));

  /** The BBB tier's join, keyed by the permit contractor name it was made for. */
  const ratingsByContractor = new Map<string, ContractorRatingMatch>();
  for (const rating of input.contractorRatings ?? []) {
    if (rating.matched) ratingsByContractor.set(rating.permitContractorName, rating);
  }

  const matchedPermitNames = new Set<string>();
  const permitTierCounts: Record<string, number> = {};
  const bbbPathCounts: Record<string, number> = {};
  let placesMatchedToPermits = 0;
  let placesMatchedDefensibly = 0;
  let placesMatchedToBbb = 0;

  const matches: RoofingBusinessMatch[] = input.roofingRows.map((row) => {
    const place = normalizeBusinessName(row.name ?? '', { truncatedInput: false });

    const permit = bestMatch(place, permitIndex, floor, true);
    if (permit) {
      placesMatchedToPermits += 1;
      if (DEFENSIBLE_TIERS.includes(permit.tier)) placesMatchedDefensibly += 1;
      matchedPermitNames.add(permit.value.name);
      permitTierCounts[permit.tier] = (permitTierCounts[permit.tier] ?? 0) + 1;
    } else {
      permitTierCounts.unmatched = (permitTierCounts.unmatched ?? 0) + 1;
    }

    const direct = bestMatch(place, bbbIndex, floor, false);
    const viaPermit = permit ? ratingsByContractor.get(permit.value.name) : undefined;

    let bbbPath: 'direct' | 'via_permit_contractor' | null = null;
    let bbbBusinessName: string | null = null;
    let bbbRating: string | null = null;
    let bbbRatingScore: number | null = null;
    let bbbProfileUrl: string | null = null;
    let bbbMatchConfidence = 0;

    if (direct) {
      bbbPath = 'direct';
      bbbBusinessName = direct.value.businessName;
      bbbRating = direct.value.rating;
      bbbRatingScore = direct.value.ratingScore;
      bbbProfileUrl = direct.value.profileUrl;
      bbbMatchConfidence = direct.score;
    } else if (viaPermit && permit) {
      bbbPath = 'via_permit_contractor';
      bbbBusinessName = viaPermit.bbbBusinessName;
      bbbRating = viaPermit.rating;
      bbbRatingScore = viaPermit.ratingScore;
      bbbProfileUrl = viaPermit.profileUrl;
      /**
       * Two fuzzy hops multiply. Reporting the BBB tier's own score here would claim more
       * confidence than the chain has, because reaching that score required first
       * believing the place-to-contractor match.
       */
      bbbMatchConfidence = Number((permit.score * viaPermit.confidence).toFixed(4));
    }

    if (bbbPath) {
      placesMatchedToBbb += 1;
      bbbPathCounts[bbbPath] = (bbbPathCounts[bbbPath] ?? 0) + 1;
    } else {
      bbbPathCounts.unmatched = (bbbPathCounts.unmatched ?? 0) + 1;
    }

    return {
      gersId: row.gers_id,
      placeName: row.name ?? '',
      placeNameKey: place.key,
      jurisdiction: row.jurisdiction,
      confidence: row.confidence,
      addressFreeform: row.address_freeform,
      websites: row.websites,
      phones: row.phones,
      permitMatched: permit !== null,
      permitContractorName: permit?.value.name ?? null,
      permitMatchTier: permit?.tier ?? null,
      permitMatchConfidence: permit?.score ?? 0,
      permitCount: permit?.value.permitCount ?? null,
      permitRunnerUpCount: permit ? Math.max(0, permit.aboveFloor - 1) : 0,
      bbbMatched: bbbPath !== null,
      bbbPath,
      bbbBusinessName,
      bbbRating,
      bbbRatingScore,
      bbbMatchConfidence,
      bbbProfileUrl,
    };
  });

  const roofingPlaces = matches.length;

  return {
    matches,
    summary: {
      release: input.release,
      roofingPlaces,
      permitContractorsConsidered: permitIndex.length,
      bbbBusinessesConsidered: bbbIndex.length,
      placesMatchedToPermits,
      placesMatchedDefensibly,
      placesMatchedToBbb,
      permitMatchRate: roofingPlaces === 0 ? 0 : round(placesMatchedToPermits / roofingPlaces),
      defensibleMatchRate: roofingPlaces === 0 ? 0 : round(placesMatchedDefensibly / roofingPlaces),
      bbbMatchRate: roofingPlaces === 0 ? 0 : round(placesMatchedToBbb / roofingPlaces),
      permitTierCounts,
      bbbPathCounts,
      permitContractorsMatched: matchedPermitNames.size,
      permitContractorsUnmatched: permitIndex.length - matchedPermitNames.size,
      permitContractorMatchRate:
        permitIndex.length === 0 ? 0 : round(matchedPermitNames.size / permitIndex.length),
      matchFloor: floor,
      defensibleTiers: [...DEFENSIBLE_TIERS],
      denominators: {
        permitContractorSource: input.permitContractorSource,
        bbbBusinessSource: input.bbbBusinessSource,
      },
    },
  };
}

function round(value: number): number {
  return Number(value.toFixed(4));
}
