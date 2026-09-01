/**
 * Type-only surface of the API package.
 *
 * `packages/api-client` imports `AppRouter` from here with `import type`, so the
 * router's runtime code is erased at build time and never reaches a browser bundle.
 */
export type { AppRouter } from './routers/index';
export type { ApiContext } from './context';
