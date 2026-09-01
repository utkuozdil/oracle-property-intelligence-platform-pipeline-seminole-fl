import { z } from 'zod';
import { publicProcedure, router } from '../trpc';
import { logger } from '../observability';
import {
  getPermitLookup,
  openRoofingCard,
  parcelPermits,
  type PermitCoverage,
  type PermitLookup,
} from './permit-lookup';
import {
  NEARBY_SORT_KEYS,
  SORT_KEYS,
  getParcelDetail,
  getParcelStore,
  resolveCentre,
  searchNearby,
  searchParcels,
  type NearbyPermitOptions,
  type NearbySortKey,
  type ParcelFilters,
  type SortKey,
} from './parcel-store';

/** Bounded so a crafted request cannot ask the Lambda to serialise the whole snapshot. */
const MAX_PAGE_SIZE = 100;

const searchInput = z.object({
  q: z.string().max(120).optional(),
  jurisdiction: z.string().max(120).optional(),
  roofAgeMin: z.number().int().min(0).max(400).optional(),
  justValueMin: z.number().min(0).optional(),
  justValueMax: z.number().min(0).optional(),
  yearBuiltMin: z.number().int().min(1500).max(2100).optional(),
  yearBuiltMax: z.number().int().min(1500).max(2100).optional(),
  yearsSinceSaleMin: z.number().int().min(0).max(400).optional(),
  ownerOutOfArea: z.boolean().optional(),
  sort: z.enum(SORT_KEYS).default('relevance'),
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(MAX_PAGE_SIZE).default(25),
});

/** Wide enough for a county-scale search, bounded so one request cannot scan the state. */
const MAX_RADIUS_MILES = 50;

const nearbyInput = searchInput
  .omit({ sort: true })
  .extend({
    lat: z.number().min(-90).max(90).optional(),
    lon: z.number().min(-180).max(180).optional(),
    /** Free text resolved against the roll when explicit coordinates are not supplied. */
    near: z.string().max(120).optional(),
    radiusMiles: z.number().positive().max(MAX_RADIUS_MILES).default(1),
    sort: z.enum(NEARBY_SORT_KEYS).default('distance_asc'),
    /** Confirmed-open roofing only. `unknown` status is not open. */
    openRoofingOnly: z.boolean().optional(),
    minOpenRoofingYears: z.number().min(0).max(80).optional(),
  })
  .refine(
    (value) =>
      (value.lat !== undefined && value.lon !== undefined) ||
      (value.near !== undefined && value.near.trim() !== ''),
    { message: 'Provide either lat and lon, or a place to search near.' },
  );

function resolveCentreFromText(
  store: Awaited<ReturnType<typeof getParcelStore>>,
  text: string,
): {
  center: { lat: number; lon: number };
  source: 'coordinates' | 'parcel';
  parcelId: string | null;
  label: string | null;
  jurisdiction: string | null;
} | null {
  const resolved = resolveCentre(store, text);
  if (resolved === null) return null;
  return {
    center: resolved.center,
    source: 'parcel',
    parcelId: resolved.parcelId,
    label: resolved.label,
    jurisdiction: resolved.jurisdiction,
  };
}

export const parcelsRouter = router({
  /**
   * Snapshot identity and the facet values the filter controls need. The UI calls this
   * once on load, which is also what warms the container before the first search.
   */
  meta: publicProcedure.query(async () => {
    const store = await getParcelStore();
    return {
      runId: store.pointer.runId,
      county: store.pointer.county,
      publishedAt: store.pointer.publishedAt,
      parcelCount: store.count,
      partitionCount: store.pointer.partitionCount,
      snapshotBytes: store.pointer.bytes,
      jurisdictions: store.jurisdictions,
      parcelsWithoutAddress: store.parcelsWithoutAddress,
      parcelsWithCoordinates: store.withCoordinates,
      parcelsWithOwnerName: store.withOwnerName,
      bounds: store.bounds,
      loadMs: store.loadMs,
      fetchMs: store.fetchMs,
      parseMs: store.parseMs,
      readyAt: store.readyAt,
      heapUsedMb: store.heapUsedMb,
    };
  }),

  search: publicProcedure.input(searchInput).query(async ({ input }) => {
    const store = await getParcelStore();
    const { sort, page, pageSize, ...rest } = input;

    // Zod leaves absent optionals undefined, which is exactly "filter not applied".
    const filters: ParcelFilters = {
      q: rest.q?.trim() === '' ? undefined : rest.q,
      jurisdiction: rest.jurisdiction === '' ? undefined : rest.jurisdiction,
      roofAgeMin: rest.roofAgeMin,
      justValueMin: rest.justValueMin,
      justValueMax: rest.justValueMax,
      yearBuiltMin: rest.yearBuiltMin,
      yearBuiltMax: rest.yearBuiltMax,
      yearsSinceSaleMin: rest.yearsSinceSaleMin,
      ownerOutOfArea: rest.ownerOutOfArea,
    };

    const result = searchParcels(store, filters, sort as SortKey, page, pageSize);
    return { ...result, runId: store.pointer.runId };
  }),

  /**
   * Radius search around a GPS point or a resolved place.
   *
   * A centre is either given as coordinates or resolved from free text against the county
   * roll — a parcel id, an address, a jurisdiction name, or an owner. Text resolution
   * always names the parcel it landed on, so the centre is never a black box, and an
   * unresolvable centre comes back as `resolved: false` rather than an error, because the
   * caller needs to say *what* it could not find.
   */
  nearby: publicProcedure.input(nearbyInput).query(async ({ input }) => {
    const store = await getParcelStore();
    const {
      sort,
      page,
      pageSize,
      radiusMiles,
      lat,
      lon,
      near,
      openRoofingOnly,
      minOpenRoofingYears,
      ...rest
    } = input;

    const centre =
      lat !== undefined && lon !== undefined
        ? {
            center: { lat, lon },
            source: 'coordinates' as const,
            parcelId: null,
            label: null,
            jurisdiction: null,
          }
        : resolveCentreFromText(store, near ?? '');

    if (centre === null) {
      return { resolved: false as const, near: near ?? null, runId: store.pointer.runId };
    }

    const filters: ParcelFilters = {
      q: rest.q?.trim() === '' ? undefined : rest.q,
      jurisdiction: rest.jurisdiction === '' ? undefined : rest.jurisdiction,
      roofAgeMin: rest.roofAgeMin,
      justValueMin: rest.justValueMin,
      justValueMax: rest.justValueMax,
      yearBuiltMin: rest.yearBuiltMin,
      yearBuiltMax: rest.yearBuiltMax,
      yearsSinceSaleMin: rest.yearsSinceSaleMin,
      ownerOutOfArea: rest.ownerOutOfArea,
    };

    const permits = await loadPermits();
    const permitOptions = nearbyPermitOptions(permits, openRoofingOnly, minOpenRoofingYears);
    const result = searchNearby(
      store,
      centre.center,
      radiusMiles,
      filters,
      sort as NearbySortKey,
      page,
      pageSize,
      permitOptions,
    );

    return {
      resolved: true as const,
      centre,
      runId: store.pointer.runId,
      ...result,
      rows: result.rows.map((row) => ({
        ...row,
        openRoofing: permits === null ? null : openRoofingCard(permits, row.parcelId),
      })),
      permits: permitCoverageBlock(permits, openRoofingOnly === true),
    };
  }),

  detail: publicProcedure
    .input(z.object({ parcelId: z.string().min(1).max(64) }))
    .query(async ({ input }) => {
      const store = await getParcelStore();
      const parcel = getParcelDetail(store, input.parcelId);
      const permits = parcel === null ? null : await loadPermits();
      return {
        parcel,
        permits: permits === null ? { available: false as const } : parcelPermits(permits, input.parcelId),
        runId: store.pointer.runId,
      };
    }),
});

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

function nearbyPermitOptions(
  permits: PermitLookup | null,
  openRoofingOnly: boolean | undefined,
  minOpenRoofingYears: number | undefined,
): NearbyPermitOptions | undefined {
  if (permits === null) return undefined;
  return {
    openRoofingOnly,
    minOpenRoofingYears,
    yearsByParcel: permits.openRoofingYearsByParcel,
  };
}

function permitCoverageBlock(
  permits: PermitLookup | null,
  filterActive: boolean,
):
  | { available: false }
  | { available: true; coverage: PermitCoverage; filterActive: boolean } {
  if (permits === null) return { available: false };
  return { available: true, coverage: permits.coverage, filterActive };
}
