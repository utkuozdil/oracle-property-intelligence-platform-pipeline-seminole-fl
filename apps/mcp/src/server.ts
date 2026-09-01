import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { ServerConfig } from './config';
import { loadConfig } from './config';
import { OracleDataset } from './queries';
import { TOOLS, jsonSchemaFor } from './tools';

/**
 * The MCP server itself.
 *
 * It holds no state beyond a memoised pointer resolution and a content-addressed file
 * cache, both of which are derivable from public data. Nothing is provisioned, nothing
 * runs between calls, and two copies of this server on two machines answer identically
 * because they read the same CID — which is why the deliverable is a package a consumer
 * runs, not a URL they depend on us to keep alive.
 */

export function createServer(config: ServerConfig = loadConfig()): Server {
  const dataset = new OracleDataset(config);

  const server = new Server(
    { name: 'oracle-seminole-open-data', version: '0.1.0' },
    {
      capabilities: { tools: {} },
      instructions:
        'Read-only access to the published Seminole County, FL property dataset (181,218 ' +
        'parcels) over public IPFS. Call describe_dataset first — it reports which data is ' +
        'present and which is not, and every tool response repeats that in its assumptions and ' +
        'missingData fields. Treat those fields as part of the answer: absence of permit data is ' +
        'reported explicitly and must not be read as absence of permits.',
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: TOOLS.map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: jsonSchemaFor(tool),
      annotations: { readOnlyHint: true, openWorldHint: true },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = TOOLS.find((candidate) => candidate.name === request.params.name);
    if (tool === undefined) {
      return errorResult(`Unknown tool ${request.params.name}`);
    }

    const parsed = tool.schema.safeParse(request.params.arguments ?? {});
    if (!parsed.success) {
      return errorResult(`Invalid arguments for ${tool.name}: ${parsed.error.message}`);
    }

    try {
      const result = await tool.run(dataset, parsed.data as Record<string, unknown>);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      // Surfaced as tool content rather than a protocol error: the model is the one that
      // has to decide what to do next, and "the gateway was slow, retry" is actionable
      // where a transport-level failure is not.
      return errorResult(error instanceof Error ? error.message : String(error));
    }
  });

  return server;
}

function errorResult(message: string): {
  content: { type: 'text'; text: string }[];
  isError: true;
} {
  return { content: [{ type: 'text', text: message }], isError: true };
}
