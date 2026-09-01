# MCP access

`apps/mcp/` is a local MCP server over the published Seminole query table. It reads
`query-table/seminole.parquet` at the stable IPNS name — the same file `just duckdb-demo`
uses. Each consumer runs their own copy. There is no hosted URL.

Needs Node 22.12+, pnpm, and the DuckDB CLI (`brew install duckdb`).

```bash
just mcp-probe    # handshake + demo questions
just mcp-serve    # stdio; point an MCP client at this process
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

The Seminole IPNS name is the default:
`k51qzi5uqu5di4rwv9bhnuzrg6xrxsugpjq8y85zhsgethars962cmosaqbh8i`.

## Tools

Every response includes `source`, `assumptions`, and `missingData`. No arbitrary-SQL tool.

| Tool | What it does |
| --- | --- |
| `describe_dataset` | Row counts, coverage, manifest, which enrichment this copy can see |
| `get_property` | One parcel by id (hyphenated or stripped) |
| `search_properties` | County-wide filters; `orderBy` includes `roof_age_desc` / `roof_age_asc` |
| `search_properties_near` | Same filters, radius around a lat/lon, ordered by distance |
| `find_roofing_leads` | Confirmed-open roofing near a pin, contractor + BBB when permits are configured |

## Permits

Permit status and BBB are **not** on the IPFS query table. They come from
`s3://$ORACLE_DATA_BUCKET/publish/permits/current.json` → `permits.parquet`.

- `just mcp-probe` sets the bucket when AWS credentials resolve.
- Without a bucket, `find_roofing_leads` answers the radius / roof-age half and marks
  permits as **unanswered** — not as zero.
- Only `status = 'open'` is open. `unknown` is unharvested, not open and not closed.

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

The URL must name the `.parquet` file, not the directory CID. Provenance is
`<ipns>/query-table/manifest.json`.
