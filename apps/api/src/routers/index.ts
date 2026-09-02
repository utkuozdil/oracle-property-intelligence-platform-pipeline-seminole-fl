import { router } from '../trpc';
import { agentRouter } from './agent';
import { entitiesRouter } from './entities';
import { parcelsRouter } from './parcels';
import { placesRouter } from './places';
import { runsRouter } from './runs';
import { systemRouter } from './system';

export const appRouter = router({
  system: systemRouter,
  runs: runsRouter,
  parcels: parcelsRouter,
  places: placesRouter,
  entities: entitiesRouter,
  agent: agentRouter,
});

export type AppRouter = typeof appRouter;
