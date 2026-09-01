import { router } from '../trpc';
import { entitiesRouter } from './entities';
import { parcelsRouter } from './parcels';
import { runsRouter } from './runs';
import { systemRouter } from './system';

export const appRouter = router({
  system: systemRouter,
  runs: runsRouter,
  parcels: parcelsRouter,
  entities: entitiesRouter,
});

export type AppRouter = typeof appRouter;
