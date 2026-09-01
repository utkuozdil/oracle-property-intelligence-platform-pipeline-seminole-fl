import { createApiClient } from '@oracle-seminole/api-client';

/**
 * The app never constructs a tRPC client itself — transport configuration lives in
 * `@oracle-seminole/api-client` so every future frontend shares one typed client.
 */
export const api = createApiClient({ url: import.meta.env.VITE_API_URL });
