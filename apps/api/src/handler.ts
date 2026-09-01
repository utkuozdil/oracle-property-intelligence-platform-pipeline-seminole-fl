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
import { writeAgentNdjson } from './agent-http-stream';
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

const middyHandler = middy(baseHandler)
  .use(injectLambdaContext(logger))
  .use(captureLambdaHandler(tracer))
  .use(logMetrics(metrics));

/**
 * tRPC over API Gateway. Kept as a buffered handler so existing /trpc routes
 * do not depend on Lambda response streaming.
 */
export const handler = middyHandler;

/**
 * Bedrock token stream. Deployed as a second Function URL with RESPONSE_STREAM.
 */
export const stream = awslambda.streamifyResponse(
  async (event: APIGatewayProxyEventV2, responseStream) => {
    await writeAgentNdjson(event, responseStream);
  },
);
