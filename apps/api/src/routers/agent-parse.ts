/**
 * Deterministic fallback for the Oracle agent.
 *
 * The live path is Bedrock (`agent-llm.ts`) with a system prompt. This parser stays so
 * the two scripted demo questions still work if the model is down, and so unit tests do
 * not need a network.
 */

export const AGENT_EXAMPLES = [
  'Which properties in Seminole County within five miles of Sanford have roofs older than 15 years?',
  'Which properties near that area have open roofing permits that have been open for many years, and who is the listed contractor?',
] as const;

export const AGENT_PLACES = [
  'Altamonte Springs',
  'Winter Springs',
  'Lake Mary',
  'Casselberry',
  'Forest City',
  'Wekiva Springs',
  'Longwood',
  'Heathrow',
  'Chuluota',
  'Sanford',
  'Oviedo',
  'Geneva',
  'Midway',
] as const;

const CURRENT_AREA = /\b(that area|this area|here|nearby|near me|the current (view|map|area))\b/i;
const MILES = /\b(\d+(?:\.\d+)?)\s*(?:mi|mile|miles)\b/i;
const WORD_MILES =
  /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|twenty[- ]five)\s+miles?\b/i;
const WORD_NUMBER: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  fifteen: 15,
  twenty: 20,
  'twenty-five': 25,
  'twenty five': 25,
};
const ROOF_AGE =
  /roofs?\s+(?:older than|over|at least|aged(?:\s+at\s+least)?|age(?:d)?)\s+(\d+)/i;
const ROOF_AGE_ALT = /(\d+)\s*[-\s]*year(?:s)?(?:\s+old)?\s+roofs?/i;
const ROOF_AGE_BARE = /roofs?\s+(\d+)\s*-?\s*years?/i;
const NEAR_UNKNOWN = /\bnear\s+([^\s,?!.][^,?!.]{0,39})/i;
const OPEN_ROOFING =
  /\bopen roofing\b|\broofing permits?\b|\bopen permits?\b|\bstalled roofing\b|\blong-?open roofing\b/i;
const SAME_QUERY =
  /\b(same query|same search|same (thing|one|filters?)|that (query|search)|those filters?)\b/i;
const MANY_YEARS = /\bmany years\b|\bstuck\b|\bopen for years\b|\blongest-?open\b/i;
const CONTRACTOR = /\b(contractor|bbb)\b/i;
const PROPERTY_SEARCH =
  /\b(propert(?:y|ies)|parcel|roofs?|roofing|permits?|house|home|owner|query|search)\b/i;

export interface AgentCriterion {
  key: string;
  label: string;
}

export interface AgentDraft {
  near: string | null;
  useCurrentArea: boolean;
  /** Keep roof-age / radius from the previous turn (“same query, but …”). */
  keepPriorFilters: boolean;
  radiusMiles: number | null;
  roofAgeMin: number | null;
  openRoofingOnly: boolean;
  minOpenRoofingYears: number | null;
  sort: 'distance_asc' | 'permit_open_desc' | 'roof_age_desc' | 'roof_age_asc';
  criteria: AgentCriterion[];
  notes: string[];
}

export type AgentParseResult =
  | { status: 'parsed'; draft: AgentDraft }
  | { status: 'refused'; reason: string };

export function parseAgentQuestion(question: string): AgentParseResult {
  const trimmed = question.trim();
  if (trimmed === '') {
    return { status: 'refused', reason: 'Type a property question first.' };
  }
  if (!PROPERTY_SEARCH.test(trimmed)) {
    return {
      status: 'refused',
      reason:
        'I only have Seminole County property data — roofs, parcels, and permits. Try Sanford, Lake Mary, Longwood, or Oviedo.',
    };
  }

  const keepPriorFilters = SAME_QUERY.test(trimmed);
  const useCurrentArea = keepPriorFilters || CURRENT_AREA.test(trimmed);
  const near = useCurrentArea ? null : placeIn(trimmed);
  const miles = firstNumber(trimmed, MILES) ?? wordMiles(trimmed);
  const roofAgeMin =
    firstNumber(trimmed, ROOF_AGE) ??
    firstNumber(trimmed, ROOF_AGE_ALT) ??
    firstNumber(trimmed, ROOF_AGE_BARE);
  const openRoofingOnly = OPEN_ROOFING.test(trimmed);
  const manyYears = MANY_YEARS.test(trimmed);
  const wantsContractor = CONTRACTOR.test(trimmed);

  if (useCurrentArea === false && near === null) {
    const outsider = unknownPlace(trimmed);
    if (outsider !== null) {
      return {
        status: 'refused',
        reason: `“${outsider}” is not a city in this Seminole County snapshot. Try Sanford, Lake Mary, Longwood, or Oviedo.`,
      };
    }
  }

  if (useCurrentArea === false && near === null && miles === null && roofAgeMin === null && !openRoofingOnly) {
    return {
      status: 'refused',
      reason:
        'I could not read a city, a radius, a roof-age threshold, or a permit filter in that question.',
    };
  }

  const minOpenRoofingYears = openRoofingOnly && manyYears ? 3 : null;
  const sort = openRoofingOnly
    ? 'permit_open_desc'
    : roofAgeMin !== null
      ? 'roof_age_desc'
      : 'distance_asc';

  const criteria: AgentCriterion[] = [];
  if (useCurrentArea) {
    criteria.push({ key: 'location', label: 'the area already on this page' });
  } else if (near !== null) {
    criteria.push({
      key: 'location',
      label:
        miles !== null
          ? `within ${formatMiles(miles)} of ${near}`
          : `near ${near}`,
    });
  }
  if (roofAgeMin !== null) {
    criteria.push({ key: 'roof_age', label: `roof age at least ${roofAgeMin} years` });
  }
  if (openRoofingOnly) {
    criteria.push({ key: 'permit_status', label: 'confirmed-open roofing permit' });
  }
  if (minOpenRoofingYears !== null) {
    criteria.push({
      key: 'permit_open_years',
      label: `open at least ${minOpenRoofingYears} years`,
    });
  }
  criteria.push({
    key: 'sort',
    label:
      sort === 'permit_open_desc'
        ? 'longest-open roofing permit first'
        : sort === 'roof_age_desc'
          ? 'oldest roof first'
          : 'nearest first',
  });

  const notes: string[] = [];
  if (openRoofingOnly) {
    notes.push(
      'Status “unknown” means the permit detail has not been harvested. It is not treated as open, and it is not treated as closed.',
    );
  }
  if (wantsContractor) {
    notes.push(
      'Contractor name and BBB rating come from each matching parcel’s open roofing permit. A missing BBB rating usually means the contractor was not searched, not that the business failed a rating.',
    );
  }
  if (roofAgeMin !== null) {
    notes.push(
      'Roof age is derived from the appraiser’s max effective year built. Parcels with no building cannot satisfy a roof-age threshold.',
    );
  }

  return {
    status: 'parsed',
    draft: {
      near,
      useCurrentArea,
      keepPriorFilters,
      radiusMiles: miles,
      roofAgeMin,
      openRoofingOnly,
      minOpenRoofingYears,
      sort,
      criteria,
      notes,
    },
  };
}

function placeIn(question: string): string | null {
  const lower = question.toLowerCase();
  for (const place of AGENT_PLACES) {
    if (lower.includes(place.toLowerCase())) return place;
  }
  return null;
}

function unknownPlace(question: string): string | null {
  const match = NEAR_UNKNOWN.exec(question);
  const raw = match?.[1]?.trim();
  if (raw === undefined || raw === '') return null;
  const cleaned = raw.replace(/\s+/g, ' ').replace(/[.]+$/, '');
  if (placeIn(cleaned) !== null) return null;
  if (CURRENT_AREA.test(`near ${cleaned}`)) return null;
  return cleaned;
}

function firstNumber(text: string, pattern: RegExp): number | null {
  const match = pattern.exec(text);
  if (match?.[1] === undefined) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

function wordMiles(text: string): number | null {
  const match = WORD_MILES.exec(text);
  if (match?.[1] === undefined) return null;
  return WORD_NUMBER[match[1].toLowerCase().replace(/\s+/g, ' ')] ?? null;
}

function formatMiles(value: number): string {
  return `${value} ${value === 1 ? 'mile' : 'miles'}`;
}
