import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The CDK assertion suite synthesises all three stacks in one `beforeAll`, and
    // synthesis esbuild-bundles every Lambda in them. That is legitimately slow and
    // grows with each new function, so the hook needs a budget that reflects a build
    // rather than the 10s default meant for a unit test.
    hookTimeout: 180_000,
    testTimeout: 30_000,
  },
});
