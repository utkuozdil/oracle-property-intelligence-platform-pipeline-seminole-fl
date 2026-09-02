# MCP access

`apps/mcp/` is a local stdio MCP server over the published Seminole query table
(`query-table/seminole.parquet` at IPNS
`k51qzi5uqu5di4rwv9bhnuzrg6xrxsugpjq8y85zhsgethars962cmosaqbh8i`).
Needs Node 22.12+, pnpm, and the DuckDB CLI (`brew install duckdb`).

```bash
just mcp-serve    # point an MCP client at this process
just mcp-probe    # handshake + tool calls
```

```json
{
  "mcpServers": {
    "oracle-seminole": {
      "command": "npx",
      "args": ["-y", "tsx", "<repo>/apps/mcp/src/cli.ts"]
    }
  }
}
```

## Tools

Every response includes `source`, `assumptions`, and `missingData`.

| Tool | What it does |
| --- | --- |
| `describe_dataset` | Row counts, coverage, manifest, enrichment this copy can see |
| `get_property` | One parcel by id (hyphenated or stripped) |
| `search_properties` | County-wide filters; `orderBy` includes `roof_age_desc` / `roof_age_asc` |
| `search_properties_near` | Same filters, radius around a lat/lon |
| `find_roofing_leads` | Open roofing near a pin, with contractor and BBB when `ORACLE_DATA_BUCKET` is set |

`find_roofing_leads` reads `s3://$ORACLE_DATA_BUCKET/publish/permits/current.json`.
Only `status = 'open'` is open.

## Same data without the server

```sql
INSTALL httpfs; LOAD httpfs;
SELECT parcel_id, primary_address, roof_age
FROM read_parquet(
  'https://ipfs.io/ipns/k51qzi5uqu5di4rwv9bhnuzrg6xrxsugpjq8y85zhsgethars962cmosaqbh8i/query-table/seminole.parquet'
)
WHERE roof_age >= 15
ORDER BY roof_age DESC NULLS LAST
LIMIT 25;
```

The URL must name the `.parquet` file. Provenance is `<ipns>/query-table/manifest.json`.
