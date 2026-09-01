import type { AppRouter } from '@oracle-seminole/api';
import { createTRPCClient, httpBatchLink } from '@trpc/client';

/**
 * The router type is re-exported so no frontend app ever reaches into `apps/api`
 * directly. This package is the single place tRPC transport is configured.
 */
export type { AppRouter };

export type ApiClient = ReturnType<typeof createApiClient>;

/**
 * Same-origin default. CloudFront routes `/trpc/*` to the API Gateway HTTP API, so
 * the browser never needs an absolute API hostname and never triggers a CORS preflight.
 */
export const DEFAULT_TRPC_URL = '/trpc';

export interface CreateApiClientOptions {
  /** Absolute or relative tRPC endpoint. Defaults to {@link DEFAULT_TRPC_URL}. */
  url?: string;
  /** Extra headers, e.g. an auth token once authentication lands. */
  headers?: Record<string, string>;
}

export function createApiClient(options: CreateApiClientOptions = {}) {
  return createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        url: options.url ?? DEFAULT_TRPC_URL,
        headers: () => options.headers ?? {},
      }),
    ],
  });
}
