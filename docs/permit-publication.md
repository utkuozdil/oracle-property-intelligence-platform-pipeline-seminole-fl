# Permit publication

How permit history reaches `publish/`, what the artifacts mean, and the one change the CRM
repository needs before the demo question can be answered.

## Why this exists

The assignment's headline demo question is asked verbatim:

> Which properties near that area have open roofing permits that have been open for many years,
> and who is the listed contractor?

The deployed CRM refused it, correctly:

> This CRM dataset holds parcels only and carries no permit history.

Permits were being harvested into `staged/permits/`, but `publish/` held one row per parcel and
nothing else, so the CRM's published data source reported `permitsAvailable: false` and dropped
the permit filter, the permit-age input, and the `permit_age` sort. The refusal was the honest
answer to a dataset that genuinely had no permits in it. This tier removes the reason for it.

## What is published

Everything lives under `publish/permits/`, which matters because the CRM's role is read-only and
IAM-restricted to the `publish/` prefix. Anything it cannot reach does not exist as far as the
product is concerned.

```
publish/permits/current.json                       stable pointer, overwritten each publish
publish/permits/snapshot=<runId>/manifest.json     the same record, run-scoped and immutable
publish/permits/snapshot=<runId>/permits.parquet
publish/permits/snapshot=<runId>/parcel-index.parquet
publish/permits/snapshot=<runId>/contractors.parquet
```

`publish/current.json` additionally carries a `permits` block naming those keys, so a consumer
that already reads the parcel pointer discovers permits without being told a second location.

### Measured size

Against snapshot `recon-verify-1788271882` (181,218 parcels) and census coverage
1996-01 → 2026-01:

| Artifact               |    Rows | Bytes        |
| ---------------------- | ------: | ------------ |
| `permits.parquet`      | 511,500 | 9.0 MiB      |
| `parcel-index.parquet` |  77,540 | 0.61 MiB     |
| `contractors.parquet`  |  17,565 | 0.25 MiB     |
| **total**              |         | **9.84 MiB** |

The CRM currently loads 56 objects / 40.7 MB and peaks at 443 MB of a 2048 MB Lambda. This adds
9.84 MB across 3 objects — 24% more bytes on the wire. A consumer that only needs to _filter_
reads `parcel-index.parquet` alone, which is 0.61 MB.

### `permits.parquet` — one row per permit row

The grain is the census's own natural key, `(AppNo, StructureSequence, PermitTypeSequence)`, so a
single application appears once per trade line. `permit_id` is that key; `application_no` groups
them. A consumer presenting a list of properties should count applications, not rows.

| Column                                                                                    | Meaning                                                                                                   |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `parcel_id`                                                                               | Bare 17-character form, matching the published parcel snapshot. `NULL` when the portal's id is malformed. |
| `parcel_published`                                                                        | Whether that id is in the parcel snapshot.                                                                |
| `permit_id`, `application_no`, `structure_sequence`, `permit_type_sequence`               | Identity.                                                                                                 |
| `issued_on`                                                                               | Issue date.                                                                                               |
| `permit_type`, `permit_type_code`                                                         | e.g. `BPFN BUILDING PERMIT FENCE/WALL`, `BPFN`.                                                           |
| `description`, `application_type_code`                                                    | e.g. `R100 REROOF RESIDENTIAL`, `R100`.                                                                   |
| `roofing_relevant`                                                                        | This tier's verdict, from the county's nine roofing application-type codes.                               |
| `contractor_name`, `valuation_usd`                                                        | As the portal renders them.                                                                               |
| `status`                                                                                  | `open` \| `closed` \| `void` \| `unknown`.                                                                |
| `status_raw`, `status_canonical`                                                          | The portal's own string, and the permits tier's canonical mapping of it.                                  |
| `open_duration_days`, `open_years`                                                        | How long the permit has been open. `NULL` unless the lifecycle is corroborated.                           |
| `open_duration_observed_at`                                                               | **When that duration was measured.**                                                                      |
| `closed_on`                                                                               | Terminal inspection result date. Absent even on some resolved work — the source has no close-date field.  |
| `bbb_lookup`                                                                              | `rated` \| `matched_unrated` \| `searched_no_match` \| `not_searched`.                                    |
| `bbb_rating`, `bbb_rating_score`, `bbb_accredited`, `bbb_business_name`, `bbb_confidence` | The BBB join.                                                                                             |

### `parcel-index.parquet` — one row per published parcel that has a permit

Pre-aggregated, and this is what makes the permit table affordable rather than a cache of it.
Without it a consumer would have to hold all 511,500 rows in heap to answer "does this parcel
have an open permit", which is the question every row of a county-wide search asks.

Carries `permit_count` and `application_count` (both grains), `roofing_permit_count`,
`open_permit_count`, `open_roofing_permit_count`, `open_roofing_application_count`,
`closed_permit_count`, `unknown_status_permit_count`, `first_permit_on`, `last_permit_on`,
`max_open_years`, `max_open_roofing_years`, and `geohash5` so it aligns with the parcel
snapshot's partitioning.

## Three coverage facts a consumer must not smooth over

Every one of these is in the manifest, generated from the numbers beside it so a note cannot
drift away from the data it describes.

**1. The census says a permit exists; it never says whether it is open.** Lifecycle comes only
from the per-permit status detail in `staged/permits/status/`, harvested application by
application. That covers **124 of 309,369 applications (0.04%)**. Every other permit is
`status = 'unknown'`, which means _unharvested_, not closed. Filtering `unknown` as if it were
closed would be a guess presented as a fact; treating it as open would invent a county-wide
backlog. It has to stay its own value.

The answerable population today is therefore small and exact: **23 confirmed-open roofing permit
rows, 16 applications, across 13 parcels**, all open more than 3 years (in fact all more than 20 —
they are 1999–2004 applications the county never closed out). That is a real filtered list, and it
is the list the demo question wants. It is small because the status sweep has barely started, not
because the county has no open permits.

One thing a presenter should know before saying "roofing" out loud: 14 of those 16 applications
carry `C998` (siding / awnings / aluminium roof / canopy, commercial) or `A998` (siding / roof
over), and exactly one — `4-13105`, CLIFFCO INC, 5567 Garden Grove Cir — is a plain `R100` reroof
residential. Both vocabularies count as roofing in the county's own `roofing_type_codes` and in
the CRM's `SEMINOLE_ROOFING_APPLICATION_TYPES`, so the classification is not wrong, but the
population is mostly commercial canopy work rather than houses needing a new roof.
`application_type_code` is published per row precisely so a consumer can narrow to `R100` and say
which it is showing.

**2. Open duration is an observation, not a property.** Source B reports how long a permit has
been open as of the moment it was read. Publishing that number bare would make it drift into a
lie the day after publication, so every row carries `open_duration_observed_at` and the manifest
states one `referenceDate` — the newest observation in the generation. A consumer reads years-open
directly and never does arithmetic against an unstated "now".

**3. The sweep is still running, and absence is bounded by its window.** Coverage is published as
a window plus its holes, and the manifest carries a sentence a consumer can quote:

> A parcel absent from `parcel-index.parquet` had no permit issued between 1996-01 and 2026-01.
> It says nothing about permits issued before 1996-01 or after 2026-01, which this sweep has not
> harvested yet.

A month count alone cannot distinguish 361 contiguous months from 361 scattered across four
decades, and the two license completely different claims. `coverage.census.contiguous` and
`coverage.census.missingMonths` state which it is.

The sweep runs **forward** from 1996-01, not backward from today: it landed 2015-12 as its last
month, then 2020-06, then 2024-05, then 2026-01 over the course of one afternoon. Re-run this
publish to pick up whatever has landed since.

### The BBB join is thin, and thin in a specific direction

The BBB run searched 405 permit contractors and rated 255 of them. The census names **17,565
distinct contractors**, so `not_searched` is the common case, and the four-value `bbb_lookup`
exists to say which kind of absence a null rating is.

For the 13 parcels that actually carry a long-open roofing permit, **none of the contractors has
a BBB rating**: 12 of 13 are `searched_no_match` (BBB was searched and has no profile) and one,
`CLIFFCO INC`, is `not_searched`. That is the honest answer to the demo script's "BBB rating where
available" clause — these are 1999–2004 contractors, mostly sole traders, and BBB has nothing on
them. The distinction between "searched and not found" and "nobody looked" is exactly what makes
that reportable rather than an unexplained blank.

## Running it

```bash
DATA_BUCKET=$(just _data-bucket) \
PERMIT_PUBLISH_WORK_DIR="$PWD/.publish-work/permits" \
  pnpm --filter @oracle-seminole/api exec tsx src/publish/permit-cli.ts [--dry-run]
```

`--dry-run` mirrors, builds and measures without writing to `publish/`. `PUBLISH_FORCE=true`
republishes a generation that is already published.

Idempotency is on content: the run id is a SHA-256 fingerprint of every input object's ETag, so a
re-run against an unchanged bucket rebuilds locally, recognises the generation, and uploads
nothing. That matters because this step is expected to be re-run repeatedly while the census
sweep advances.

The build needs DuckDB on `PATH` (or `DUCKDB_BIN`), single-threaded with a total ordering on every
`COPY` so the same inputs produce byte-identical Parquet. Scratch is ~350 MB of mirrored census
NDJSON and is reused between runs.

### The `just` recipe to add

Not added here: the justfile is shared and outside this tier's ownership. It belongs beside
`publish-ipfs`:

```make
# Publish permit history into publish/. `--dry-run` builds and measures, uploads nothing.
publish-permits *ARGS:
    #!/usr/bin/env bash
    set -euo pipefail
    export DATA_BUCKET="$(just _data-bucket)"
    export PERMIT_PUBLISH_WORK_DIR="{{ justfile_directory() }}/.publish-work/permits"
    cd {{ TS_CDK_DIR }} && pnpm exec tsx src/publish/permit-cli.ts {{ ARGS }}
```

## Two things this tier deliberately did not do

**It did not reuse `reduceToCurrent` from `apps/api/src/permits/reconcile-status.ts`.** That
reducer orders status observations by a `harvestedAt` field, and no staged status record carries
one. Every comparison therefore degenerates to its run-id tiebreak, which is lexicographic, so
`verify-closed` outranks `roof-hunt-r12` — and measured against the bucket that is exactly
backwards: the `verify-*` objects are the oldest in `staged/permits/status/` (14:37–14:51) and the
`roof-hunt-*` objects the newest (15:34–15:39). Reusing it would publish each permit's _first_
observed status as its current one. `reduceToCurrentObservation` in `src/publish/permits.ts` orders
on the S3 object's `LastModified` instead, which is a real observation instant. **This is a live
defect in the permits tier**, not just an inconvenience here: its own `long-open-roofing.json`
leaderboard is built through the same reducer. Fixing it means either stamping `harvestedAt` onto
the staged records at harvest time or ordering on the object metadata — a change in
`apps/api/src/permits/`, which this tier does not own.

**It did not write the parcel-id normalisation twice.** `normaliseParcelId` and `PARCEL_ID` in
`apps/api/src/permits/reconcile-census.ts` are the definitions. The join runs inside DuckDB over
half a million rows, so they are transcribed into SQL in `src/publish/permits.ts`, and
`permits.test.ts` imports the originals and asserts the two agree on real parcel ids — including
the alphanumeric blocks (`5MF`, `0S00`, `ROW`, `064S`) that the permits tier documents as having
silently broken an earlier, stricter pattern. The same technique covers `applicationCodeOf`. If
either original changes, the test fails rather than the join quietly returning nothing.

## The CRM change this needs — and it does need one

**The published data is in place and discoverable, and the CRM still refuses the question.** That
is not a publication problem. `permitsAvailable` is a hard-coded constant in the CRM repository,
not something read from the pointer, so no amount of publishing can flip it.

Verified live after publishing:

```
POST /trpc/nlq.ask {"question":"Which properties near Altamonte Springs have open roofing
                    permits that have been open for many years, and who is the contractor?"}
  -> status: "refused"

GET /trpc/properties.dataset
  -> permitsAvailable: false
```

The changes are all in `roofing-crm`, which this repository must not edit:

1. **`apps/api/src/data/published-source.ts`** — `PublishedPropertyDataSource` declares
   `readonly permitsAvailable = false` and returns a shared frozen `NO_PERMITS` array on every
   record. Both are literals. It needs to take permit availability from the loaded artifact,
   populate `PropertyDetail.permits`, evaluate `permitStatus` and `minPermitOpenYears` inside
   `matchesColumns`, drop those two entries from `unsupportedFilters`, give `comparator` a real
   `permit_age` case instead of falling through to `distance`, and report `permitsAvailable: true`
   from `provenance()`.
2. **`apps/api/src/data/parcel-snapshot.ts`** — `parcelSnapshotPointerSchema` already ignores
   unknown fields, so `publish/current.json` parses unchanged. It needs an optional `permits`
   block added to the schema and a loader for `parcel-index.parquet` (and `permits.parquet` where
   the detail panel needs trade lines). `hyparquet` reads both; no new dependency.
3. **Nothing in `routers/nlq.ts` or `nlq/parse.ts`.** Both already branch on
   `propertySource.permitsAvailable` and on `usesPermitHistory`, so the refusal lifts on its own
   once (1) reports `true`.

Two mapping notes for whoever makes that change:

- `PermitRecord.status` is a `PermitStatus` from the CRM's own seven-value vocabulary
  (`pre_issuance` … `unknown`), not this artifact's four-value `status`. Map from
  `status_canonical`, or from `status_raw` through the CRM's own `mapSeminolePermitStatus`. Using
  `status` directly would collapse `active`, `blocked` and `pre_issuance` into one bucket.
- `PermitRecord.structure_sequence` and `permit_type_sequence` are typed `number | null`, but the
  county renders them as composite strings — `"0 0"` and `"BPFN 0"`. The artifact publishes the
  source strings. Either the CRM's type widens to `string | null`, or it relies on `permit_id`,
  which is already the full natural key.

Also worth knowing: `publish/current.json` is written whole by
`apps/api/src/pipeline/publish-snapshot.ts`, so the next parcel publish drops the `permits` block
until this step is re-run. `publish/permits/current.json` is unaffected and is the durable
pointer. Making the block survive means having that step preserve an existing `permits` key when
it rewrites the pointer — a change in `apps/api/src/pipeline/`, again outside this tier.
