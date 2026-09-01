# Agent access to the published dataset over MCP

The acceptance criteria ask the system to "structure the database to support MCP access"
and to "enable agent access to query the database". This is that layer: an MCP server, in
`apps/mcp/`, that exposes the already-published Seminole County dataset to any agent that
speaks the protocol.

It reads what is already published and changes nothing about how the data is shaped. No
new export, no reshaped table, no additional column. The server issues DuckDB queries
against `query-table/seminole.parquet` at the same IPNS address `just duckdb-demo` uses,
so the "IPFS + DuckDB, minimal hosted infrastructure" claim holds from the pipeline
straight through to the consuming agent.

## Run it

Prerequisites: Node 22.12+, pnpm, and the DuckDB CLI (`brew install duckdb`, or set
`DUCKDB_BIN`). The DuckDB dependency is deliberate — the publish step wrote this Parquet
with the same binary, and an embedded second engine would mean querying the artifact with
something other than what produced it.

```bash
pnpm install --config.verify-deps-before-run=false

# Talk to it as an agent would: spawn it over stdio, list its tools, ask the demo's
# questions, and time every round trip.
just mcp-probe                      # or: pnpm --filter @oracle-seminole/mcp run probe

# Or just start it and wire a client to the process.
just mcp-serve                      # or: pnpm --filter @oracle-seminole/mcp run start
```

`just mcp-probe` wires in the private permit and BBB sources when AWS credentials
resolve; `MCP_ENRICHMENT=off just mcp-probe` forces the outside-consumer path, where the
server has no access to either. Both are worth watching, so neither is the hidden one.

Point an MCP client at the process rather than at a URL:

```json
{
  "mcpServers": {
    "oracle-seminole": {
      "command": "npx",
      "args": ["-y", "tsx", "<repo>/apps/mcp/src/cli.ts"],
      "env": {
        "ORACLE_OPEN_DATA_IPNS": "k51qzi5uqu5di4rwv9bhnuzrg6xrxsugpjq8y85zhsgethars962cmosaqbh8i"
      }
    }
  }
}
```

`ORACLE_OPEN_DATA_IPNS` is optional — the Seminole name is the default — but naming it
makes the deployment self-describing and lets one checkout serve another county's
publication without a code change.

## Hosted or local: local, and why

**Each consuming agent runs its own copy. There is nothing to deploy and no URL to keep
alive.** That follows the open-data MCP skill's model, and three properties of this
dataset make it the right call rather than the convenient one:

- **The data is public and content-addressed.** Every consumer reads the same IPNS name
  and the same CID. A hosted endpoint would add a hop that can be slow, down, rate-limited
  or subtly stale, in exchange for no capability the local copy lacks.
- **The server is stateless.** It holds a memoised pointer resolution and a file cache
  keyed by CID; both are derivable from public data and reconstructed in one call. There
  is no session, no write path and no shared state, so there is nothing for a central
  deployment to coordinate.
- **The only credential in the picture belongs to the consumer.** Permit and BBB
  enrichment read the pipeline's private S3 bucket. A hosted server could not use a
  consumer's AWS credentials on their behalf, and handing out ours would be worse than
  not offering the feature. Running locally, an operator's own credential chain applies
  and nothing is transmitted anywhere.

Hosting also costs something for nothing: a Lambda or container, a URL, TLS, auth, and a
per-request egress charge against the same 5 GB Filebase allowance the published data
already draws on.

The trade-off, stated plainly: a consumer must have Node and the DuckDB CLI, and each one
pays their own first-call download (about 10 s for 22 MB). A hosted copy would amortise
that across users. If this ever needs to serve a browser or a CRM that cannot run a
subprocess, the same `createServer()` mounts on a streamable-HTTP transport unchanged —
the constraint is the transport, not the design.

## Tools

Every response carries the same envelope alongside its data: `source` (IPNS name, CID,
how it was read, query milliseconds), `assumptions`, and `missingData`. Those fields are
part of the answer. The demo is graded on identifying assumptions and missing data, and a
tool that returns bare rows forces the consuming agent to invent that part.

| Tool                     | Arguments                                                                                                                                                                                                                                                                          | Returns                                                                                                                                                                                 |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `describe_dataset`       | none                                                                                                                                                                                                                                                                               | Row counts, coordinate and roof-age coverage, jurisdictions, the publisher's own manifest (run id, provenance, fingerprint), and which enrichment sources this copy can and cannot see. |
| `get_property`           | `parcelId`                                                                                                                                                                                                                                                                         | Every published column for one parcel. Accepts both spellings of the id (see below).                                                                                                    |
| `search_properties`      | `minRoofAge`, `maxRoofAge`, `minYearBuilt`, `maxYearBuilt`, `jurisdiction`, `propertyType`, `addressContains`, `ownerNameContains`, `minJustValue`, `maxJustValue`, `soldBefore`, `soldAfter`, `minYearsSinceSale`, `ownerOutOfArea`, `hasBuilding`, `hasPool`, `orderBy`, `limit` | `totalMatches` plus a 16-column summary page.                                                                                                                                           |
| `search_properties_near` | `latitude`, `longitude`, `radiusMiles`, all of the above filters, `limit`                                                                                                                                                                                                          | The same, restricted to a radius and ordered by `miles_from_pin`.                                                                                                                       |
| `find_roofing_leads`     | `latitude`, `longitude`, `radiusMiles`, `minRoofAge`, `minPermitOpenYears`, `limit`                                                                                                                                                                                                | The demo's headline question, with permit and contractor evidence when available and an explicit statement of what is unanswered when it is not.                                        |

There is deliberately no "run arbitrary SQL" tool. It would be powerful and impossible to
describe honestly in a tool description; the SQL shape is documented below instead, for a
consumer who would rather skip the server entirely.

### Parcel ids have two spellings

The permit portal writes `15-21-29-527-0000-0140`. The published table writes
`15212952700000140` — the same 17 characters without the county's separators. Verified
against the staged sweep: 0 of 17 open roofing permits joined on the raw string, 16 of 17
joined after stripping (the seventeenth names a parcel absent from the published
snapshot). `get_property` accepts either form, and the permit join uses the stripped one.

## What is missing, and how the server says so

The published query table has 55 columns and none of them is a permit or a BBB rating.
Permit history is still being swept into private staging; BBB contractor ratings live
beside it. Neither is on IPFS.

So `find_roofing_leads` on a default (outside-consumer) copy answers the _near this area_
and _aged roof_ halves of the question and reports the rest as **unanswered**, not as a
negative result:

```json
"permitEvidence": {
  "available": false,
  "reason": "Permit history is not part of the published IPFS dataset — … an empty permit list here means \"not published\", not \"no permits\". …",
  "consequence": "The \"open roofing permit\", \"open for many years\" and \"listed contractor\" parts of the question are UNANSWERED by this server, not answered negatively."
}
```

An operator who _does_ have bucket access can wire the staged sources in. They stay
opt-in, off by default, and the response still declares that it is reading outside the
published dataset:

```bash
ORACLE_DATA_BUCKET="$(just _data-bucket)" pnpm --filter @oracle-seminole/mcp run probe
# which is what `just mcp-probe` does for you
```

`ORACLE_DATA_BUCKET` derives both locations:

| Variable                   | Value                                                      |
| -------------------------- | ---------------------------------------------------------- |
| `ORACLE_PERMIT_STATUS_URI` | `s3://<bucket>/staged/permits/status/run=*/batch-*.ndjson` |
| `ORACLE_BBB_POINTER_URI`   | `s3://<bucket>/staged/bbb/contractor-ratings/current.json` |

The BBB entry is the **pointer**, never the run prefix: superseded runs are left in place
beside the current one, and a glob unions a 1,248-business run with a 470-business one
without saying so. Permits have no such pointer, so that one is a glob across every sweep,
deduplicated on the permit number inside the query, preferring the row that carries a
close date.

This mirrors the boundary the open-data MCP skill draws around on-demand permit
harvesting: a co-located deployment can reach private pipeline state, a remote consumer's
copy cannot, and the difference is declared rather than hidden.

## Worked example: the demo's headline question

_"Which properties near that area have open roofing permits that have been open for many
years, and who is the listed contractor?"_

`find_roofing_leads({ latitude: 28.8117, longitude: -81.2734, radiusMiles: 5, minRoofAge: 15, minPermitOpenYears: 3 })`,
with enrichment configured, returns one lead and the coverage that qualifies it:

```json
{
  "answered": "yes, within the coverage stated below",
  "leads": [
    {
      "parcel_id": "2819305NQ00000040",
      "primary_address": "4510 W SR 46 SANFORD FL 32771",
      "jurisdiction": "Unincorporated Seminole County",
      "owner_name": "DB REAL ESTATES ASSETS I LLC",
      "roof_age": 22,
      "total_just_value": 1570846,
      "miles_from_pin": 3.36,
      "permit_number": "3-12597",
      "permit_applied_on": "2003-11-07",
      "permit_type": "SIDING/AWNINGS/AL ROOF/CANOPY COMMERCIAL",
      "permit_status": "PERMIT ISSUED",
      "permit_lifecycle": "open",
      "permit_open_years": 22.8,
      "listed_contractor": "SUNDANCE MANUFACTURING INC",
      "bbbRating": null,
      "contractor_match_method": "normalized-name"
    }
  ],
  "permitEvidence": {
    "sweepCoverage": {
      "permits_in_sweep": 124,
      "roofing_permits": 92,
      "open_roofing_permits": 17,
      "parcels_covered": 115,
      "parcels_matched_to_published": 113,
      "parcels_published": 181218
    }
  }
}
```

One lead, not because Seminole County has one aged open roofing permit, but because the
sweep has reached 115 parcels of 181,218 so far. `sweepCoverage` is in the response so a
reader can see that immediately. `bbbRating: null` means BBB lists no rating for that
contractor — it is a sign company, not a roofer — and is not a poor rating.

Contractor names are joined to BBB on a normalised name (upper-cased, parentheticals,
punctuation and a trailing corporate suffix removed). Measured on the current sweep, 6 of
55 distinct permit contractors resolve to a BBB record; the other 49 are awning, screen
and sign companies and individual owner-builders that BBB's roofing corpus rightly does
not list. `contractor_match_method` records that the join was fuzzy.

## Measured latency

Through `https://ipfs.io`, from a laptop, against the live published Parquet
(`bafybeidlhbnfuuu3awjwexf3ehudcqpp46de26ruwkzqcgk5lzqj2zfcru`, 22 MB, 181,218 rows):

| Call                              | Gateway only (`ORACLE_MCP_CACHE_DIR=off`) | Cached, first call                      | Cached, warm |
| --------------------------------- | ----------------------------------------- | --------------------------------------- | ------------ |
| `describe_dataset`                | 7,714 ms                                  | 10,123 ms (includes the 22 MB download) | 1,046 ms     |
| `get_property`                    | 11,626 ms                                 | 98 ms                                   | 148 ms       |
| `search_properties`               | 8,974 ms                                  | 58 ms                                   | 72 ms        |
| `search_properties_near` (3 mi)   | 5,093 ms                                  | 59 ms                                   | 74 ms        |
| `search_properties_near` (repeat) | 4,636 ms                                  | 59 ms                                   | 79 ms        |

Reading straight off the gateway works — DuckDB range-reads row groups, so a query pulls a
fraction of the file — but every call pays gateway round trips, and public gateway latency
is not ours to control. The cache is keyed by the **CID of the Parquet itself**, which
makes it safe without a TTL: a re-publish moves the IPNS name to a new CID, misses the
cache, and re-downloads. The CID a tool reports is the CID it read. `describe_dataset`
stays around a second warm because it also fetches the publisher's `manifest.json` over
the gateway rather than reciting numbers of its own.

`find_roofing_leads` with enrichment measured 3.6–10.7 s, essentially all of it listing
and reading the S3 sweep glob. That path is the private one; the published-data half stays
in the tens of milliseconds.

## The documented query structure, without the server

The acceptance criterion allows "a documented MCP-compatible query structure". The server
above is the strong version, but the structure it relies on is worth stating on its own,
because it is the reason the MCP layer needed no change to the data model. Any agent, in
any language, can reach the same data with DuckDB and no server at all:

```sql
INSTALL httpfs; LOAD httpfs;
CREATE VIEW properties AS SELECT * FROM read_parquet(
  'https://ipfs.io/ipns/k51qzi5uqu5di4rwv9bhnuzrg6xrxsugpjq8y85zhsgethars962cmosaqbh8i/query-table/seminole.parquet'
);

-- get_property
SELECT * FROM properties WHERE parcel_id = '2819305NQ00000040';

-- search_properties
SELECT parcel_id, primary_address, roof_age, total_just_value
FROM properties
WHERE roof_age >= 25 AND jurisdiction ILIKE '%Sanford%'
ORDER BY roof_age DESC NULLS LAST LIMIT 25;

-- search_properties_near: bounding box first so DuckDB can prune row groups over range
-- requests, then haversine for the exact radius.
WITH candidates AS (
  SELECT parcel_id, primary_address, roof_age,
         3958.8 * 2 * asin(sqrt(
           pow(sin(radians(latitude - 28.8117) / 2), 2) +
           cos(radians(28.8117)) * cos(radians(latitude)) *
           pow(sin(radians(longitude - -81.2734) / 2), 2))) AS miles_from_pin
  FROM properties
  WHERE latitude IS NOT NULL
    AND latitude BETWEEN 28.8117 - (3.0 / 69.0) AND 28.8117 + (3.0 / 69.0)
    AND longitude BETWEEN -81.2734 - (3.0 / (69.0 * cos(radians(28.8117))))
                      AND -81.2734 + (3.0 / (69.0 * cos(radians(28.8117))))
    AND roof_age >= 25
)
SELECT * FROM candidates WHERE miles_from_pin <= 3.0 ORDER BY miles_from_pin LIMIT 25;
```

**The URL must name the `.parquet` file.** The dataset CID is a directory; pointing DuckDB
at it fails with `No magic bytes found`, which reads like a corrupt file rather than a
wrong path. The server range-probes for `PAR1` on startup and says so explicitly if the
path is wrong.

Provenance for any of this — run id, source fingerprint, row count, coverage — is in
`<ipns-url>/query-table/manifest.json`, in the same IPFS directory as the data.

## Verification

- `just mcp-probe` — spawns the server as a subprocess,
  completes the MCP handshake, lists the tools, and answers four questions end to end
  against live IPFS, printing per-call latency. This is the proof that the protocol path
  works, not only the SQL.
- `pnpm --filter @oracle-seminole/mcp test` — 33 tests. Filter compilation and quote
  escaping, parcel-id reconciliation, permit deduplication, pointer-not-prefix resolution,
  configuration defaults, and protocol behaviour over an in-memory transport (tool
  listing, schema-driven argument rejection, unknown tools, and failures arriving as
  readable tool content rather than transport errors). No test touches the network.
- IPNS proof: no CID is pinned anywhere in the configuration. The server resolves
  `/ipns/<name>/query-table/seminole.parquet` on every start and reports the CID the
  gateway resolved through, so a re-publish is picked up with no redeploy and no edit.

## Known gaps

- **Permit history is not published.** Until it is, an outside consumer's copy cannot
  answer the permit half of the headline question at all. The server says so; it does not
  return an empty list.
- **The permit sweep has no `current.json` pointer** the way BBB ratings do, so the
  enrichment location must be named explicitly by an operator instead of being discovered.
  Deduplication on the permit number makes a multi-run glob safe, but "which runs are
  current" is a judgement the server cannot make for itself.
- **BBB coverage is a roofing corpus.** A missing rating is not a bad rating, and the
  name join is fuzzy. Both are stated on every enriched response.
- **`total_living_area` is null for commercial parcels**, so value-per-square-foot filters
  behave differently across property types. Untouched here; it is a property of the
  published table.
