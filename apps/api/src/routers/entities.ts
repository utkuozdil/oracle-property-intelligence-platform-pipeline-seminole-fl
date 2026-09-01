import { z } from 'zod';
import { publicProcedure, router } from '../trpc';
import { getOwnerProfile, getParcelStore, topOwners } from './parcel-store';
import { getRunSummary } from './run-summary';

/**
 * Canonical entities and the relationships between them.
 *
 * A parcel is not the only thing worth navigating to. An owner is an entity in its own
 * right: one owner spans many parcels, and following that edge is how a portfolio becomes
 * visible. Owners are resolved from the county roll's free-text owner name through a
 * normalised key, so a parcel links to its owner and the owner links back to every parcel
 * it holds.
 *
 * Contractors are the other entity the brief asks for, and the honest position is that no
 * contractor data has been loaded. Rather than omit the entity, `contractor` reports its
 * ingestion state and the measured facts from source research, so the gap is explicit and
 * the view starts working the moment permit contractor names and DBPR licences land.
 */

const OWNER_PAGE_SIZE_MAX = 100;

export const entitiesRouter = router({
  owner: publicProcedure
    .input(
      z.object({
        owner: z.string().min(1).max(200),
        page: z.number().int().min(1).default(1),
        pageSize: z.number().int().min(1).max(OWNER_PAGE_SIZE_MAX).default(25),
      }),
    )
    .query(async ({ input }) => {
      const store = await getParcelStore();
      const startedAt = Date.now();
      const owner = getOwnerProfile(store, input.owner, input.page, input.pageSize);
      return {
        owner,
        runId: store.pointer.runId,
        /** Provenance for every field on this view; there is exactly one source. */
        provenance: {
          source: 'SCPA CAMA extract — owner name and mailing labels',
          url: 'https://files.scpafl.org/data/cama/SeminoleCounty.zip',
          snapshotRunId: store.pointer.runId,
          publishedAt: store.pointer.publishedAt,
        },
        tookMs: Date.now() - startedAt,
      };
    }),

  /** Largest owner portfolios: the entry point into the owner entity views. */
  topOwners: publicProcedure
    .input(
      z.object({
        limit: z.number().int().min(1).max(200).default(50),
        minParcels: z.number().int().min(1).max(1000).default(2),
      }),
    )
    .query(async ({ input }) => {
      const store = await getParcelStore();
      const startedAt = Date.now();
      const owners = topOwners(store, input.limit, input.minParcels);
      return {
        owners,
        distinctOwners: store.ownerIndex?.size ?? null,
        parcelsWithOwnerName: store.withOwnerName,
        runId: store.pointer.runId,
        tookMs: Date.now() - startedAt,
      };
    }),

  /**
   * Contractor entity state. Returns whatever the source catalogue reports for the
   * contractor category, so this view degrades to a documented gap instead of an error
   * while contractor ingestion is outstanding.
   */
  contractor: publicProcedure
    .input(z.object({ name: z.string().max(200).optional() }).optional())
    .query(async ({ input }) => {
      const summary = await getRunSummary();
      const sources = summary.sources.filter((source) => source.category === 'contractor');
      const permits = summary.permits;

      return {
        query: input?.name ?? null,
        /** True only once a contractor source is actually loaded. */
        available: sources.some((source) => source.status === 'ingested'),
        sources,
        /** Permit harvest is where contractor names will first appear. */
        permitHarvest:
          permits === null
            ? null
            : {
                status: permits.status,
                runId: permits.runId,
                permitRows: permits.rows,
                roofingRows: permits.roofingRows,
                collectedAt: permits.collectedAt,
              },
        limitations: summary.limitations.filter((limitation) =>
          limitation.scope.startsWith('Contractor'),
        ),
      };
    }),
});
