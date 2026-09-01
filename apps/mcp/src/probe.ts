import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

/**
 * An end-to-end proof, run as a real MCP client.
 *
 * It spawns the server exactly the way a consuming agent would — as a subprocess over
 * stdio — performs the protocol handshake, lists the tools and calls them, timing each
 * round trip. Nothing here reaches into the server's internals, so a pass means the
 * protocol path works and not merely that the SQL does.
 *
 * `just mcp-probe` runs it. Output is a transcript, meant to be read.
 */

interface Step {
  label: string;
  tool: string;
  args: Record<string, unknown>;
  /** Printed in full, or summarised down to these paths when the payload is large. */
  show?: string[];
}

/** Downtown Sanford, the pin the DuckDB demo already uses. */
const SANFORD = { latitude: 28.8117, longitude: -81.2734 };

/**
 * Convenience wiring for an operator who has bucket access.
 *
 * `ORACLE_DATA_BUCKET=$(just _data-bucket) pnpm --filter @oracle-seminole/mcp run probe`
 * exercises the enriched path; without it the probe runs exactly as an outside consumer's
 * copy does, and the server reports the permit half of the headline question as
 * unanswered. Both are worth seeing, so neither is the hidden one.
 *
 * The BBB entry is the `current.json` pointer, never the run prefix: superseded runs are
 * left in place beside the current one and a glob silently unions them. There is no such
 * pointer for permits, so that one is a glob over every sweep, deduplicated on the permit
 * number inside the query.
 */
function enrichmentFromBucket(env: NodeJS.ProcessEnv): void {
  const bucket = env.ORACLE_DATA_BUCKET?.trim();
  if (bucket === undefined || bucket === '') return;
  env.ORACLE_PERMIT_STATUS_URI ??= `s3://${bucket}/staged/permits/status/run=*/batch-*.ndjson`;
  env.ORACLE_BBB_POINTER_URI ??= `s3://${bucket}/staged/bbb/contractor-ratings/current.json`;
}

const STEPS: Step[] = [
  {
    label: 'What is in this dataset, and what is missing from it?',
    tool: 'describe_dataset',
    args: {},
  },
  {
    label: 'Aged roofs within 3 miles of downtown Sanford, owner out of area',
    tool: 'search_properties_near',
    args: {
      ...SANFORD,
      radiusMiles: 3,
      minRoofAge: 25,
      ownerOutOfArea: true,
      hasBuilding: true,
      limit: 5,
    },
    show: ['totalMatches', 'returned', 'results', 'source'],
  },
  {
    label: 'Everything published about the closest of those parcels',
    tool: 'get_property',
    args: { parcelId: '__FROM_PREVIOUS__' },
    show: ['found', 'property'],
  },
  {
    label: 'The headline question: open roofing permits held open for years, and the contractor',
    tool: 'find_roofing_leads',
    args: { ...SANFORD, radiusMiles: 5, minRoofAge: 15, minPermitOpenYears: 3, limit: 5 },
  },
];

function out(text: string): void {
  process.stdout.write(`${text}\n`);
}

function firstText(result: Record<string, unknown>): string {
  const content = result.content;
  if (!Array.isArray(content)) return '';
  const block = content.find((entry) => (entry as { type?: string }).type === 'text');
  return (block as { text?: string } | undefined)?.text ?? '';
}

function project(payload: Record<string, unknown>, keys: string[] | undefined): unknown {
  if (keys === undefined) return payload;
  return Object.fromEntries(keys.map((key) => [key, payload[key]]));
}

async function main(): Promise<void> {
  enrichmentFromBucket(process.env);
  const here = dirname(fileURLToPath(import.meta.url));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(here, '..', 'node_modules', 'tsx', 'dist', 'cli.mjs'), join(here, 'cli.ts')],
    env: Object.fromEntries(
      Object.entries(process.env).filter(([, value]) => value !== undefined),
    ) as Record<string, string>,
    stderr: 'inherit',
  });

  const client = new Client({ name: 'oracle-mcp-probe', version: '0.1.0' });
  const connectStart = Date.now();
  await client.connect(transport);
  out(`connected over stdio in ${Date.now() - connectStart} ms`);
  out(
    process.env.ORACLE_PERMIT_STATUS_URI === undefined
      ? 'permit/BBB enrichment: OFF (this is what an outside consumer sees)'
      : 'permit/BBB enrichment: ON (private staged sources, operator only)',
  );

  const { tools } = await client.listTools();
  out(`\ntools (${tools.length}):`);
  for (const tool of tools) {
    const properties = (tool.inputSchema.properties ?? {}) as Record<string, unknown>;
    out(`  ${tool.name}(${Object.keys(properties).join(', ') || ''})`);
  }

  let lastParcelId: string | null = null;

  for (const step of STEPS) {
    const args = { ...step.args };
    if (args.parcelId === '__FROM_PREVIOUS__') {
      if (lastParcelId === null) {
        out(`\n--- ${step.label}\n  skipped: no parcel from the previous step`);
        continue;
      }
      args.parcelId = lastParcelId;
    }

    out(`\n${'='.repeat(78)}\n${step.label}\n  ${step.tool}(${JSON.stringify(args)})`);
    const startedAt = Date.now();
    const result = await client.callTool({ name: step.tool, arguments: args });
    const elapsed = Date.now() - startedAt;

    const text = firstText(result);
    if (result.isError === true) {
      out(`  FAILED after ${elapsed} ms: ${text}`);
      continue;
    }

    const payload = JSON.parse(text) as Record<string, unknown>;
    const results = payload.results;
    if (Array.isArray(results) && results.length > 0) {
      const parcel = (results[0] as { parcel_id?: string }).parcel_id;
      if (typeof parcel === 'string') lastParcelId = parcel;
    }

    out(`  round trip ${elapsed} ms`);
    out(JSON.stringify(project(payload, step.show), null, 2));
  }

  await client.close();
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
