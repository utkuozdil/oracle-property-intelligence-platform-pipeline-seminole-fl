import { z } from 'zod';
import { getRun } from '../lib/table';
import { publicProcedure, router } from '../trpc';
import { peekParcelStore } from './parcel-store';
import { getRunSummary } from './run-summary';

export const runsRouter = router({
  /**
   * Proves the `RUN#<runId>` / `META` access pattern and the Lambda's table grant. Run
   * history for the UI comes from {@link runsRouter.summary}, which reads the manifests
   * the ingestion phases write rather than the control-plane item.
   */
  byId: publicProcedure
    .input(z.object({ runId: z.string().min(1) }))
    .query(async ({ input, ctx }) => {
      ctx.logger.info('Fetching run', { runId: input.runId });
      return { runId: input.runId, item: await getRun(input.runId) };
    }),

  /**
   * Everything the pipeline run summary view shows: run history with deltas, the source
   * catalogue with record counts and provenance, permit progress, reconciliation results,
   * IPFS references, and documented source limitations.
   *
   * Coverage figures are taken from the already-loaded parcel snapshot when this container
   * happens to hold one. It is never loaded on demand here — a 5 s Parquet parse must not
   * sit in front of the first page a reviewer opens.
   */
  summary: publicProcedure.query(async () => {
    const store = peekParcelStore();
    return getRunSummary({
      parcelStats:
        store === null
          ? null
          : { withCoordinates: store.withCoordinates, withOwnerName: store.withOwnerName },
    });
  }),
});
