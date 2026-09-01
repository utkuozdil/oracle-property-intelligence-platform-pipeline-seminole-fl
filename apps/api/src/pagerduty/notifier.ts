import { injectLambdaContext } from '@aws-lambda-powertools/logger/middleware';
import { logMetrics } from '@aws-lambda-powertools/metrics/middleware';
import { captureLambdaHandler } from '@aws-lambda-powertools/tracer/middleware';
import middy from '@middy/core';
import { METRIC_ITEMS } from '@oracle-seminole/shared';
import { logger, metrics, recordWork, tracer } from '../observability';
import { triggerPagerDuty, type PagerDutyTrigger, type PagerDutyTriggerResult } from './client';

/**
 * Async-invoked alert sink. Every critical failure path in this service routes here
 * instead of calling PagerDuty inline, which keeps the routing-key IAM grant on one
 * function and gives the alert path its own DLQ.
 */
async function baseHandler(event: PagerDutyTrigger): Promise<PagerDutyTriggerResult> {
  return recordWork(METRIC_ITEMS.alert, () => triggerPagerDuty(event));
}

export const handler = middy(baseHandler)
  .use(injectLambdaContext(logger))
  .use(captureLambdaHandler(tracer))
  .use(logMetrics(metrics));
