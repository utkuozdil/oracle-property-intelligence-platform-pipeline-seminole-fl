import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config';
import { createServer } from './server';
import { TOOLS, jsonSchemaFor } from './tools';

/**
 * Protocol-level tests over an in-memory transport.
 *
 * They exercise the same handlers a stdio client reaches, without touching the network:
 * a consuming agent's first two interactions are "what tools are there" and "what happens
 * when I call one wrong", and both are answerable offline. The network path is proved
 * separately and visibly by `just mcp-probe`.
 */
async function connected(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer(
    loadConfig({ ORACLE_MCP_PARQUET_URL: '/tmp/does-not-exist.parquet' }),
  );
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe('the MCP server', () => {
  it('advertises the five tools with generated JSON Schema', async () => {
    const client = await connected();
    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name)).toEqual([
      'describe_dataset',
      'get_property',
      'search_properties',
      'search_properties_near',
      'find_roofing_leads',
    ]);
    for (const tool of tools) {
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.annotations?.readOnlyHint).toBe(true);
    }
    await client.close();
  });

  it('requires the arguments its schema advertises', async () => {
    const client = await connected();
    const result = await client.callTool({ name: 'search_properties_near', arguments: {} });
    expect(result.isError).toBe(true);
    await client.close();
  });

  it('names an unknown tool instead of failing the transport', async () => {
    const client = await connected();
    const result = await client.callTool({ name: 'drop_table', arguments: {} });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('drop_table');
    await client.close();
  });

  it('reports a query failure as tool content the model can act on', async () => {
    const client = await connected();
    const result = await client.callTool({ name: 'get_property', arguments: { parcelId: 'x' } });
    // The configured Parquet does not exist, so this is the failure path — the point is
    // that it arrives as a readable message rather than a protocol-level exception.
    expect(result.isError).toBe(true);
    await client.close();
  });
});

describe('the tool descriptions', () => {
  it('warn about the permit gap where an agent will actually read them', () => {
    const leads = TOOLS.find((tool) => tool.name === 'find_roofing_leads');
    expect(leads?.description).toContain('NOT in the IPFS query table');

    const describe = TOOLS.find((tool) => tool.name === 'describe_dataset');
    expect(describe?.description).toContain('never mistaken for "no permits"');
  });

  it('generates schemas that accept the arguments the descriptions promise', () => {
    const near = TOOLS.find((tool) => tool.name === 'search_properties_near');
    const schema = jsonSchemaFor(near!) as { required?: string[] };
    expect(schema.required).toEqual(['latitude', 'longitude', 'radiusMiles']);
  });
});
