import { router } from '../trpc';
import { runsRouter } from './runs';
import { systemRouter } from './system';

export const appRouter = router({
  system: systemRouter,
  runs: runsRouter,
});

export type AppRouter = typeof appRouter;
