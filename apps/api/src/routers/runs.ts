import { z } from 'zod';
import { getRun } from '../lib/table';
import { publicProcedure, router } from '../trpc';

export const runsRouter = router({
  /**
   * Phase 0 read path. It exists to prove the `RUN#<runId>` / `META` access pattern and
   * the Lambda's table grant are wired; run history and delta reporting arrive with the
   * ingestion phases.
   */
  byId: publicProcedure
    .input(z.object({ runId: z.string().min(1) }))
    .query(async ({ input, ctx }) => {
      ctx.logger.info('Fetching run', { runId: input.runId });
      return { runId: input.runId, item: await getRun(input.runId) };
    }),
});
