import type { CreateAWSLambdaContextOptions } from '@trpc/server/adapters/aws-lambda';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { logger, metrics, tracer } from './observability';

export function createContext({
  event,
  context,
}: CreateAWSLambdaContextOptions<APIGatewayProxyEventV2>) {
  return {
    event,
    lambdaContext: context,
    requestId: event.requestContext.requestId,
    logger,
    tracer,
    metrics,
  };
}

export type ApiContext = ReturnType<typeof createContext>;
