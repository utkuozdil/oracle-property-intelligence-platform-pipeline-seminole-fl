import { injectLambdaContext } from '@aws-lambda-powertools/logger/middleware';
import { logMetrics } from '@aws-lambda-powertools/metrics/middleware';
import { captureLambdaHandler } from '@aws-lambda-powertools/tracer/middleware';
import middy from '@middy/core';
import { METRIC_ITEMS } from '@oracle-seminole/shared';
import { awsLambdaRequestHandler } from '@trpc/server/adapters/aws-lambda';
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
  Context,
} from 'aws-lambda';
import { createContext } from './context';
import { logger, metrics, recordWork, tracer } from './observability';
import { appRouter } from './routers/index';

const trpcHandler = awsLambdaRequestHandler({
  router: appRouter,
  createContext,
  onError({ error, path }) {
    logger.error('tRPC request errored', { path, code: error.code, error });
  },
});

async function baseHandler(
  event: APIGatewayProxyEventV2,
  context: Context,
): Promise<APIGatewayProxyStructuredResultV2> {
  return recordWork(METRIC_ITEMS.request, () => trpcHandler(event, context));
}

export const handler = middy(baseHandler)
  .use(injectLambdaContext(logger))
  .use(captureLambdaHandler(tracer))
  .use(logMetrics(metrics));
