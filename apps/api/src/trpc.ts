import { initTRPC } from '@trpc/server';
import type { ApiContext } from './context';

const t = initTRPC.context<ApiContext>().create();

export const router = t.router;
export const middleware = t.middleware;

/**
 * Emits one structured log line per procedure call. Keys are passed per-call rather
 * than appended to the logger, because a Lambda container is reused across
 * invocations and appended keys would leak into unrelated requests.
 */
const withRequestLogging = t.middleware(async ({ ctx, path, type, next }) => {
  const scope = { procedure: path, procedureType: type, requestId: ctx.requestId };
  const result = await next();
  if (result.ok) {
    ctx.logger.info('Procedure completed', scope);
  } else {
    ctx.logger.error('Procedure failed', { ...scope, error: result.error });
  }
  return result;
});

export const publicProcedure = t.procedure.use(withRequestLogging);
