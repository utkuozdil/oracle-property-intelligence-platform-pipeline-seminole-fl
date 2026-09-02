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

Every response includes `source`, `assumptions`, and `missingData` (shown once at the end).

| Tool | What it does |
| --- | --- |
| `describe_dataset` | Row counts, coverage, manifest, enrichment this copy can see |
| `get_property` | One parcel by id (hyphenated or stripped) |
| `search_properties` | County-wide filters; `orderBy` includes `roof_age_desc` / `roof_age_asc` |
| `search_properties_near` | Same filters, radius around a lat/lon |
| `find_roofing_leads` | Open roofing near a pin, with contractor and BBB when `ORACLE_DATA_BUCKET` is set |

`find_roofing_leads` reads `s3://$ORACLE_DATA_BUCKET/publish/permits/current.json`.
Only `status = 'open'` is open.

Examples below are live responses, trimmed to one row.

### `describe_dataset()`

```json
{
  "county": "Seminole County, FL",
  "table": {
    "rows": 181218,
    "rows_with_coordinates": 181218,
    "rows_with_roof_age": 161979,
    "roofs_over_15_years": 142188,
    "oldest_year_built": 1872,
    "latest_sale_date": "2026-08-25",
    "jurisdictions": 8
  },
  "publishedManifest": {
    "runId": "recon-verify-1788271882",
    "publishedAt": "2026-09-01T14:16:20.247Z",
    "rows": 181218,
    "columns": 55
  },
  "enrichment": {
    "permits": { "available": true },
    "bbb": { "available": true }
  }
}
```

### `search_properties({ minRoofAge: 25, jurisdiction: "Sanford", hasBuilding: true, limit: 1 })`

```json
{
  "totalMatches": 9382,
  "returned": 1,
  "appliedFilters": { "minRoofAge": 25, "jurisdiction": "Sanford", "hasBuilding": true },
  "results": [
    {
      "parcel_id": "13203030001600000",
      "primary_address": "6498 N RONALD REAGAN BLVD SANFORD FL 32773",
      "jurisdiction": "Sanford",
      "property_type": "Residential",
      "owner_name": "CHRISTIAN SHARING CENTER INC",
      "year_built": 1900,
      "roof_age": 126,
      "last_sale_date": "2025-01-16",
      "total_just_value": 300431
    }
  ]
}
```

### `search_properties_near({ latitude: 28.8117, longitude: -81.2734, radiusMiles: 3, minRoofAge: 25, ownerOutOfArea: true, hasBuilding: true, limit: 1 })`

```json
{
  "centre": { "latitude": 28.8117, "longitude": -81.2734 },
  "radiusMiles": 3,
  "totalMatches": 1224,
  "returned": 1,
  "results": [
    {
      "parcel_id": "2519305AG02090010",
      "primary_address": "110 N FRENCH AVE SANFORD FL 32771",
      "jurisdiction": "Sanford",
      "owner_name": "7-ELEVEN INC",
      "owner_out_of_area": true,
      "year_built": 1985,
      "roof_age": 41,
      "total_just_value": 839720,
      "miles_from_pin": 0.04
    }
  ]
}
```

### `get_property({ parcelId: "2519305AG02090010" })`

Returns every published column (55). Subset:

```json
{
  "found": true,
  "property": {
    "parcel_id": "2519305AG02090010",
    "primary_address": "110 N FRENCH AVE SANFORD FL 32771",
    "jurisdiction": "Sanford",
    "property_type": "Commercial",
    "owner_name": "7-ELEVEN INC",
    "mailing_city_state_zip": "IRVING, TX 75063-0131",
    "year_built": 1985,
    "roof_age": 41,
    "total_just_value": 839720,
    "latitude": 28.81226568,
    "longitude": -81.27370227
  },
  "openRoofing": []
}
```

### `find_roofing_leads({ latitude: 28.8117, longitude: -81.2734, radiusMiles: 5, minPermitOpenYears: 3, limit: 1 })`

```json
{
  "answered": "yes, within the coverage stated below",
  "returned": 1,
  "leads": [
    {
      "parcel_id": "2819305NQ00000040",
      "primary_address": "4510 W SR 46 SANFORD FL 32771",
      "jurisdiction": "Unincorporated Seminole County",
      "owner_name": "DB REAL ESTATES ASSETS I LLC",
      "roof_age": 22,
      "permit_number": "3-12597",
      "permit_type": "BPC BLDG PMT COMMERCIAL",
      "permit_status": "open",
      "permit_open_years": 22.82,
      "listed_contractor": "SUNDANCE MANUFACTURING INC",
      "bbb_rating": null
    }
  ],
  "permitEvidence": {
    "available": true,
    "snapshotCoverage": {
      "permit_rows": 522358,
      "roofing_permits": 55957,
      "open_roofing_permits": 691,
      "unknown_status_rows": 476240
    }
  }
}
```

### Envelope on every response

```json
{
  "source": {
    "dataset": "query-table/seminole.parquet",
    "ipns": "k51qzi5uqu5di4rwv9bhnuzrg6xrxsugpjq8y85zhsgethars962cmosaqbh8i",
    "url": "https://ipfs.io/ipns/k51qzi5uqu5di4rwv9bhnuzrg6xrxsugpjq8y85zhsgethars962cmosaqbh8i/query-table/seminole.parquet",
    "cid": "bafybeidlhbnfuuu3awjwexf3ehudcqpp46de26ruwkzqcgk5lzqj2zfcru",
    "readFrom": "local-cache"
  },
  "assumptions": [
    "roof_age is derived from the appraiser's effective-year-built, not from a roof permit."
  ],
  "missingData": []
}
```

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
