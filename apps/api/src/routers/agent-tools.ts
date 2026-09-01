/**
 * Tools the Oracle agent may call. The model never sees the parcel store itself —
 * these functions are the only way it obtains rows.
 */

import { tool } from 'ai';
import { z } from 'zod';
import { AGENT_PLACES } from './agent-parse';
import { getPermitLookup, openRoofingCard, type BbbLookup, type PermitLookup } from './permit-lookup';
import {
  getParcelStore,
  resolveCentre,
  searchNearby,
  type NearbyRow,
  type NearbySortKey,
} from './parcel-store';
import { logger } from '../observability';

export const AGENT_PAGE_SIZE = 8;
export const AGENT_DEFAULT_AREA = 'Sanford';
export const AGENT_TOOL_NAMES = ['list_places', 'search_parcels'] as const;

export const AGENT_SORTS = [
  'distance_asc',
  'roof_age_desc',
  'roof_age_asc',
  'permit_open_desc',
  'last_sale_date_desc',
  'total_just_value_desc',
  'total_just_value_asc',
  'year_built_desc',
  'year_built_asc',
] as const;

export type AgentSort = (typeof AGENT_SORTS)[number];

const SORT_LABEL: Record<AgentSort, string> = {
  distance_asc: 'nearest first',
  roof_age_desc: 'oldest roof first',
  roof_age_asc: 'newest roof first',
  permit_open_desc: 'longest-open roofing permit first',
  last_sale_date_desc: 'most recent sale first',
  total_just_value_desc: 'highest just value first',
  total_just_value_asc: 'lowest just value first',
  year_built_desc: 'newest building first',
  year_built_asc: 'oldest building first',
};

export const searchParcelsInputSchema = z.object({
  near: z
    .string()
    .nullish()
    .describe('Seminole city. Omit to keep the last centre.'),
  radiusMiles: z
    .number()
    .min(0.25)
    .max(50)
    .nullish()
    .describe('Radius in miles. Omit to keep the last radius. Default 5 on a first search.'),
  roofAgeMin: z
    .number()
    .min(0)
    .max(400)
    .nullish()
    .describe('Minimum roof age. Omit to keep the last value. null to drop it.'),
  roofAgeMax: z
    .number()
    .min(0)
    .max(400)
    .nullish()
    .describe('Maximum roof age. Omit to keep the last value. null to drop it.'),
  openRoofingOnly: z
    .boolean()
    .nullish()
    .describe('Confirmed-open roofing only. Omit to keep. null to drop.'),
  minOpenRoofingYears: z
    .number()
    .min(0)
    .max(80)
    .nullish()
    .describe('Minimum years a roofing permit has been open. Omit to keep. null to drop.'),
  sort: z
    .enum(AGENT_SORTS)
    .nullish()
    .describe('Rank rows. Omit to keep the last sort.'),
  keepPriorFilters: z
    .boolean()
    .nullish()
    .describe('Unused. Omitted fields already keep the last search.'),
  usePriorArea: z.boolean().nullish().describe('Unused. Omitting near already keeps the last city.'),
});

export type SearchParcelsInput = z.infer<typeof searchParcelsInputSchema>;

export interface AgentThreadContext {
  currentNear?: string;
  currentRadiusMiles?: number;
  currentRoofAgeMin?: number;
  currentRoofAgeMax?: number;
  currentOpenRoofingOnly?: boolean;
  currentMinOpenRoofingYears?: number;
  currentSort?: AgentSort;
}

/** undefined = inherit; null = clear; value = set. */
export function overlay<T>(incoming: T | null | undefined, prior: T | undefined): T | undefined {
  if (incoming === undefined) return prior;
  if (incoming === null) return undefined;
  return incoming;
}

export interface AgentHit {
  parcelId: string;
  displayTitle: string;
  ownerName: string | null;
  jurisdiction: string | null;
  roofAge: number | null;
  distanceMiles: number;
  openRoofing: {
    maxOpenYears: number | null;
    contractorName: string | null;
    bbbRating: string | null;
    bbbLookup: BbbLookup;
  } | null;
}

export interface AgentSearchSuccess {
  ok: true;
  near: string;
  radiusMiles: number;
  roofAgeMin: number | undefined;
  roofAgeMax: number | undefined;
  openRoofingOnly: boolean;
  minOpenRoofingYears: number | null;
  sort: NearbySortKey;
  criteria: Array<{ key: string; label: string }>;
  notes: string[];
  evidence: string;
  total: number;
  rows: AgentHit[];
  centre: {
    label: string;
    parcelId: string;
    lat: number;
    lon: number;
  };
  source: {
    parcelRunId: string;
    permitRunId: string | null;
    permitNote: string;
  };
}

export interface AgentSearchFailure {
  ok: false;
  message: string;
}

export type AgentSearchResult = AgentSearchSuccess | AgentSearchFailure;

function resolveSearch(input: SearchParcelsInput, context: AgentThreadContext) {
  const near = overlay(input.near?.trim() || null, context.currentNear);
  const radiusMiles = overlay(input.radiusMiles, context.currentRadiusMiles) ?? 5;
  const roofAgeMin = overlay(input.roofAgeMin, context.currentRoofAgeMin);
  const roofAgeMax = overlay(input.roofAgeMax, context.currentRoofAgeMax);
  const openRoofingOnly = overlay(input.openRoofingOnly, context.currentOpenRoofingOnly) === true;
  const minOpenRoofingYears =
    overlay(input.minOpenRoofingYears, context.currentMinOpenRoofingYears) ?? null;
  const sort: NearbySortKey =
    overlay(input.sort, context.currentSort) ??
    (openRoofingOnly
      ? 'permit_open_desc'
      : roofAgeMin !== undefined
        ? 'roof_age_desc'
        : 'distance_asc');
  return { near, radiusMiles, roofAgeMin, roofAgeMax, openRoofingOnly, minOpenRoofingYears, sort };
}

export async function runAgentSearch(
  input: SearchParcelsInput,
  context: AgentThreadContext,
): Promise<AgentSearchResult> {
  const resolved = resolveSearch(input, context);
  const notes: string[] = [];
  let near = resolved.near ?? null;

  if (near === null || near === '') {
    near = AGENT_DEFAULT_AREA;
    notes.unshift(
      `No prior area was set in this chat, so I used ${AGENT_DEFAULT_AREA} — the county seat.`,
    );
  }

  const { radiusMiles, roofAgeMin, roofAgeMax, openRoofingOnly, minOpenRoofingYears, sort } =
    resolved;

  const store = await getParcelStore();
  const centre = resolveCentre(store, near);
  if (centre === null) {
    return {
      ok: false,
      message: `I cannot locate “${near}” in this Seminole snapshot. Try Sanford, Lake Mary, Longwood, or Oviedo.`,
    };
  }

  const permits = await loadPermits();
  const result = searchNearby(
    store,
    centre.center,
    radiusMiles,
    { roofAgeMin, roofAgeMax },
    sort,
    1,
    AGENT_PAGE_SIZE,
    permits === null
      ? undefined
      : {
          openRoofingOnly,
          minOpenRoofingYears: minOpenRoofingYears ?? undefined,
          yearsByParcel: permits.openRoofingYearsByParcel,
        },
  );

  const locationLabel = `within ${radiusMiles} miles of ${near}`;
  const roofAgeLabel =
    roofAgeMin !== undefined && roofAgeMax !== undefined
      ? `roof age ${roofAgeMin}–${roofAgeMax} years`
      : roofAgeMin !== undefined
        ? `roof age at least ${roofAgeMin} years`
        : roofAgeMax !== undefined
          ? `roof age at most ${roofAgeMax} years`
          : null;
  const criteria = [
    { key: 'location', label: locationLabel },
    ...(roofAgeLabel !== null ? [{ key: 'roof_age', label: roofAgeLabel }] : []),
    ...(openRoofingOnly ? [{ key: 'permit_status', label: 'confirmed-open roofing permit' }] : []),
    ...(minOpenRoofingYears !== null
      ? [{ key: 'permit_open_years', label: `open at least ${minOpenRoofingYears} years` }]
      : []),
    {
      key: 'sort',
      label: SORT_LABEL[sort as AgentSort] ?? sort,
    },
  ];

  if (openRoofingOnly) {
    notes.push(
      'Status “unknown” means the permit detail has not been harvested. It is not treated as open, and it is not treated as closed.',
    );
    notes.push(
      'Contractor name and BBB rating come from each matching parcel’s open roofing permit.',
    );
  }
  if (roofAgeMin !== undefined || roofAgeMax !== undefined) {
    notes.push(
      'Roof age is derived from the appraiser’s max effective year built. Parcels with no building cannot satisfy a roof-age threshold.',
    );
  }

  const evidence = openRoofingOnly
    ? `Parcels from snapshot ${store.pointer.runId}. Permits from ${permits?.coverage.runId ?? 'unavailable'}; contractor and BBB are fields on those permit rows. Status “unknown” is unharvested, not open.`
    : `Parcels from snapshot ${store.pointer.runId}. Roof age is the appraiser’s max effective year built.`;

  return {
    ok: true,
    near,
    radiusMiles,
    roofAgeMin,
    roofAgeMax,
    openRoofingOnly,
    minOpenRoofingYears,
    sort,
    criteria,
    notes,
    evidence,
    total: result.total,
    rows: result.rows.map((row) => toHit(row, permits)),
    centre: {
      label: centre.label,
      parcelId: centre.parcelId,
      lat: centre.center.lat,
      lon: centre.center.lon,
    },
    source: {
      parcelRunId: store.pointer.runId,
      permitRunId: permits?.coverage.runId ?? null,
      permitNote: evidence,
    },
  };
}

function toHit(row: NearbyRow, permits: PermitLookup | null): AgentHit {
  const card = permits === null ? null : openRoofingCard(permits, row.parcelId);
  return {
    parcelId: row.parcelId,
    displayTitle: row.displayTitle,
    ownerName: row.ownerName,
    jurisdiction: row.jurisdiction,
    roofAge: row.roofAge,
    distanceMiles: row.distanceMiles,
    openRoofing:
      card === null
        ? null
        : {
            maxOpenYears: card.maxOpenYears,
            contractorName: card.contractorName,
            bbbRating: card.bbbRating,
            bbbLookup: card.bbbLookup,
          },
  };
}

async function loadPermits(): Promise<PermitLookup | null> {
  try {
    return await getPermitLookup();
  } catch (error: unknown) {
    logger.error('permit lookup failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function compactSearchForModel(result: AgentSearchResult): unknown {
  if (!result.ok) return result;
  return {
    ok: true,
    near: result.near,
    radiusMiles: result.radiusMiles,
    roofAgeMin: result.roofAgeMin ?? null,
    roofAgeMax: result.roofAgeMax ?? null,
    sort: result.sort,
    openRoofingOnly: result.openRoofingOnly,
    minOpenRoofingYears: result.minOpenRoofingYears,
    total: result.total,
    evidence: result.evidence,
    rows: result.rows.map((row) => ({
      parcelId: row.parcelId,
      address: row.displayTitle,
      roofAge: row.roofAge,
      distanceMiles: Number(row.distanceMiles.toFixed(2)),
      contractor: row.openRoofing?.contractorName ?? null,
      yearsOpen: row.openRoofing?.maxOpenYears ?? null,
      bbb: row.openRoofing?.bbbRating ?? null,
    })),
  };
}

export function createAgentTools(context: AgentThreadContext, sink: { lastSearch?: AgentSearchResult }) {
  return {
    list_places: tool({
      description:
        'List the Seminole County cities this snapshot can locate. Call this when the operator names a place you are unsure about.',
      inputSchema: z.object({}),
      execute: async () => ({ places: [...AGENT_PLACES] }),
    }),
    search_parcels: tool({
      description:
        'Search published Seminole parcels around a city. Returns real rows with roof age, and contractor/BBB when openRoofingOnly is true. Never invent rows — this tool is the only source.',
      inputSchema: searchParcelsInputSchema,
      execute: async (input: SearchParcelsInput) => {
        const result = await runAgentSearch(input, context);
        sink.lastSearch = result;
        return compactSearchForModel(result);
      },
    }),
  };
}
