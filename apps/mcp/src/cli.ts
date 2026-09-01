#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server';

/**
 * stdio entry point.
 *
 * stdio rather than HTTP because there is nothing to host: the data is public and
 * content-addressed, the server is stateless, and the only configuration that could ever
 * need protecting — the optional S3 enrichment — is the *consumer's* own AWS
 * credentials, which a shared endpoint could not use on their behalf anyway.
 *
 * Nothing may be written to stdout: it is the protocol channel. Diagnostics go to stderr.
 */
async function main(): Promise<void> {
  const server = createServer();
  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
