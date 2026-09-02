import { z } from 'zod';
import { publicProcedure, router } from '../trpc';
import {
  PLACE_SORT_KEYS,
  getPlace,
  getPlaceStore,
  searchPlaces,
  type PlaceFilters,
  type PlaceRecord,
  type PlaceSortKey,
} from './place-store';

const MAX_PAGE_SIZE = 100;

const searchInput = z.object({
  q: z.string().max(120).optional(),
  jurisdiction: z.string().max(120).optional(),
  category: z.string().max(120).optional(),
  status: z.string().max(80).optional(),
  roofingOnly: z.boolean().optional(),
  sort: z.enum(PLACE_SORT_KEYS).default('name_asc'),
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(MAX_PAGE_SIZE).default(25),
});

/** Drop the search index — the SPA never needs it and it is not a published field. */
function publicPlace(place: PlaceRecord): Omit<PlaceRecord, 'searchKey'> {
  const { searchKey: _searchKey, ...rest } = place;
  return rest;
}

export const placesRouter = router({
  /**
   * Snapshot identity and the facet values the filter controls need.
   *
   * Called once when the Businesses view opens, which is also what warms this table in a
   * container that has so far only served parcels.
   */
  meta: publicProcedure.query(async () => {
    const store = await getPlaceStore();
    return {
      runId: store.pointer.runId,
      release: store.pointer.release,
      publishedAt: store.pointer.publishedAt,
      placeCount: store.places.length,
      roofingCount: store.roofingCount,
      unnamedCount: store.unnamedCount,
      jurisdictions: store.jurisdictions,
      categories: store.categories,
      statuses: store.statuses,
      loadMs: store.loadMs,
      fetchMs: store.fetchMs,
      parseMs: store.parseMs,
      readyAt: store.readyAt,
    };
  }),

  search: publicProcedure.input(searchInput).query(async ({ input }) => {
    const store = await getPlaceStore();
    const { sort, page, pageSize, ...rest } = input;
    const filters: PlaceFilters = {
      q: rest.q?.trim() === '' ? undefined : rest.q,
      jurisdiction: rest.jurisdiction === '' ? undefined : rest.jurisdiction,
      category: rest.category === '' ? undefined : rest.category,
      status: rest.status === '' ? undefined : rest.status,
      roofingOnly: rest.roofingOnly,
    };
    const result = searchPlaces(store, filters, sort as PlaceSortKey, page, pageSize);
    return {
      ...result,
      rows: result.rows.map(publicPlace),
      runId: store.pointer.runId,
      release: store.pointer.release,
    };
  }),

  detail: publicProcedure
    .input(z.object({ gersId: z.string().min(1).max(200) }))
    .query(async ({ input }) => {
      const store = await getPlaceStore();
      const place = getPlace(store, input.gersId);
      return {
        place: place === null ? null : publicPlace(place),
        runId: store.pointer.runId,
        release: store.pointer.release,
        publishedAt: store.pointer.publishedAt,
        provenance: {
          source: 'Overture Maps places theme',
          url: 'https://overturemaps.org/',
          release: store.pointer.release,
          snapshotRunId: store.pointer.runId,
          publishedAt: store.pointer.publishedAt,
        },
      };
    }),
});
