import { AWS_REGION, COUNTY, SERVICE_NAME } from '@oracle-seminole/shared';
import { z } from 'zod';
import { summarisePrefixes } from '../lib/data-bucket';
import { probeTable } from '../lib/table';
import { publicProcedure, router } from '../trpc';

export const systemRouter = router({
  /** Liveness: answers without touching any downstream dependency. */
  health: publicProcedure.query(() => ({
    status: 'ok' as const,
    service: SERVICE_NAME,
    county: COUNTY,
    region: AWS_REGION,
    phase: 'phase-0' as const,
    checkedAt: new Date().toISOString(),
  })),

  /**
   * Readiness: confirms the Lambda can reach both stores it owns — the single table and
   * the data-lake bucket — using its own execution role.
   */
  readiness: publicProcedure.input(z.object({}).optional()).query(async ({ ctx }) => {
    const [dynamodb, s3] = await Promise.all([
      probeTable().then(
        () => 'reachable' as const,
        (error: unknown) => {
          ctx.logger.error('DynamoDB readiness probe failed', { error });
          return 'unreachable' as const;
        },
      ),
      summarisePrefixes().then(
        (prefixes) => prefixes,
        (error: unknown) => {
          ctx.logger.error('S3 readiness probe failed', { error });
          return null;
        },
      ),
    ]);

    return {
      ready: dynamodb === 'reachable' && s3 !== null,
      dependencies: {
        dynamodb,
        dataBucket: s3 === null ? 'unreachable' : 'reachable',
      },
      prefixes: s3 ?? [],
    };
  }),
});
