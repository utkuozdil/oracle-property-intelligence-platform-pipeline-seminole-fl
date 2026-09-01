# Seminole County — Business Records via Overture Maps

The pipeline's **business records** source. Every number below was measured against live data
on 2026-09-01 with DuckDB 1.5.5; nothing is inferred from documentation.

Implementation: `apps/api/src/places/`. Tests: `apps/api/src/places/places.test.ts` (31 tests).

---

## Headline

| Metric                                       | Value                                |
| -------------------------------------------- | ------------------------------------ |
| Overture release (pinned)                    | `2026-08-19.0`                       |
| Business locations, county-clipped           | **26,446**                           |
| Bounding-box diagnostic (not a county count) | 31,168                               |
| Rejected by the geometric test               | 4,722                                |
| Distinct GERS ids / null geometries          | 26,446 / **0**                       |
| Roofing-category businesses                  | **162** (150 distinct names)         |
| Licence gate                                 | **PASS** — 10 providers, no `osm`    |
| Confidence range                             | 0.0178 – 1.0, median 0.9199          |
| Published Parquet                            | 2.43 MB, 34 columns, ZSTD            |
| Extract runtime                              | 45 s (one release), 93 s (with diff) |
| Credentials required                         | **none**                             |

The whole source is read unsigned from a public S3 bucket and a public Census endpoint. There
is nothing to rotate, nothing to provision, and no fixed cost between runs.

---

## Why Overture replaced Sunbiz

The Florida state corporate registry was the assumed business-records source. It is cut, with
evidence recorded in `docs/seminole-contractor-business-sources.md` and confirmed on the day:

- **The bulk feed is 17.20 GiB uncompressed** (12,808,196 fixed-width 1,440-byte records
  across ten ZIP members) and only ~1.8% of it is Seminole-scoped. There is no server-side
  filter, so the whole archive must be streamed to keep about 230,000 rows.
- **There is no published record layout.** The offsets in that document were derived
  empirically; two named fields remain unresolved and the personal-name sub-splitting is
  unconfirmed. Fixed-width parsing fails silently — a wrong offset yields plausible garbage
  rather than an error — so trusting it needs its own validation harness.
- **The quarterly and daily feeds use different line terminators** (1,442 vs 1,441 bytes per
  record). Get it wrong and every field after the first record shifts by one byte per line.
- **The per-entity web lookup is genuinely Cloudflare-blocked**: HTTP 403 with a real
  "Just a moment..." interstitial and **zero cookies issued**, so there is no cookie-replay
  path of the kind that works for the DBPR licence CSV. No browser tier was added and none
  should be.

Estimated 3–5 days of bespoke streaming-decompression and fixed-width parser work, for a
source that appears in no demo scenario.

**Overture Maps costs one query.** It is also the better fit for what the brief actually asks
for. "Business records" in the demo transcript sits beside property, permit, ownership,
contractor and coordinate records — all of which are _locations_. Overture describes where a
business operates, with a category taxonomy and coordinates. A corporate registry describes
who is registered, with officers and filing dates. Only one of those answers "which roofing
companies operate in Longwood".

The two are not interchangeable and nothing here is loaded into a `companies` table. A place
is not a legal entity.

---

## 1. Release pinning

```
s3://overturemaps-us-west-2/release/2026-08-19.0/theme=places/type=place/*.parquet
```

Confirmed two ways: the STAC catalog at `https://stac.overturemaps.org/catalog.json` reports
`latest: 2026-08-19.0`, and an unsigned bucket listing shows **only two releases retained** —
`2026-07-22.0` and `2026-08-19.0`. Anything older is gone.

That retention window is why the release is pinned in `config.ts` rather than resolved at run
time. Overture's taxonomy changes quarterly, so a category count means nothing without the
release it was counted in — and a count taken against a release that has since been deleted is
unreproducible. Every run reports drift against STAC; only `--fail-on-drift` treats it as an
error. Moving the pin is a commit, which makes it reviewable.

Both `taxonomy` and the deprecated `categories` are present in this release. `categories` is
removed from the September 2026 release onward, so all category logic keys on
`taxonomy.hierarchy` and `categories.primary` is retained only as `legacy_category_primary`.
Both agreed at 162 roofing records here, which is the evidence that switching the key changed
nothing except the field it reads.

## 2. County boundary, not a bounding box

A bounding box is not a county, and the gap is large enough to matter:

| Scope                                | Places     |
| ------------------------------------ | ---------- |
| Crude box (−81.5..−80.9, 28.6..28.9) | 37,621     |
| Boundary bounding box (measured)     | 31,168     |
| **Inside the county polygon**        | **26,446** |

A bbox-scoped ingest would have published roughly **11,000 Orange and Volusia County
businesses as Seminole ones**.

The boundary comes from Census TIGERweb, layer `State_County/MapServer/1`, selected by
`GEOID='12117'` — by FIPS rather than name, because Oklahoma also has a Seminole County and a
name filter would have silently returned an empty extract instead of an error.

- One HTTPS GET, 108,190 bytes, **2,647 vertices** at full TIGER/Line resolution.
- Layer-reported vintage: **January 1, 2025**.
- SHA-256 of the served bytes: `3fd557a876ad5f52eeea8e75799a67f5f29f3f76a808e02a415c971a6f8e227c`.

The fingerprint is the point. TIGERweb serves "current", so a vintage label alone cannot
distinguish two responses — without a hash, "the border moved" is indistinguishable from "the
data changed". The exact bytes are persisted under `raw/places/boundary/` before anything is
computed from them.

Sanity check: the layer reports `AREALAND` of 801,317,561 m², matching Seminole County's known
801 km² land area.

The predicate is two-stage and the order is load-bearing. `ST_Within` cannot be pushed into
Parquet, so a literal bounding-box comparison prunes row groups first; that is the difference
between a 45-second extract and an unusable one. The bbox count is a diagnostic and is never
reported as a county count.

## 3. Jurisdiction is assigned by geometry

Every record carries a `jurisdiction` from the **same eight-value vocabulary the parcel
snapshot uses**, which makes it a real join key between a business and a parcel:

| Jurisdiction                   | Places |
| ------------------------------ | -----: |
| Unincorporated Seminole County |  8,508 |
| Altamonte Springs              |  4,164 |
| Sanford                        |  3,927 |
| Lake Mary                      |  2,620 |
| Longwood                       |  2,220 |
| Oviedo                         |  2,139 |
| Casselberry                    |  1,880 |
| Winter Springs                 |    988 |

Assigned by point-in-polygon against TIGERweb incorporated places (layer
`Places_CouSub_ConCity_SubMCD/MapServer/4`), queried by envelope and deliberately **not**
filtered to the seven Seminole municipalities. Fourteen cities came back — Orlando, Apopka,
Maitland, Winter Park, Eatonville, DeBary and Deltona alongside the seven — and **none of the
out-of-county cities claimed a single record that survived the county clip**. A filtered query
could not have produced that evidence.

### Postal locality disagrees with geometry 1,628 times, and that is surfaced, not resolved

`address_locality` is kept verbatim beside `jurisdiction`, with a
`locality_matches_jurisdiction` boolean. **1,628 of 26,446 records (6.2%)** carry a postal
locality that is null or names a non-Seminole city — Winter Park (718), Apopka (439), Maitland
(279), Orlando (50) and others. These are geometrically inside Seminole County; postal city
names legitimately cross county lines, which is exactly why the bbox approach looked plausible
and was wrong.

Geometry owns the record. The disagreement is published so a consumer can see it rather than
having it silently resolved in either direction.

## 4. Confidence is carried through, and nothing is dropped

Measured across all 26,446 clipped places: **min 0.0178, median 0.9199, mean 0.8099, max
1.0**. The 0.53–0.92 range visible in a small hand sample is not the population range.

| Band      | Places |  Share |
| --------- | -----: | -----: |
| < 0.50    |  2,917 | 11.03% |
| 0.50–0.60 |  1,633 |  6.17% |
| 0.60–0.70 |  1,487 |  5.62% |
| 0.70–0.80 |  1,976 |  7.47% |
| 0.80–0.90 |  2,445 |  9.25% |
| 0.90–0.95 |  9,795 | 37.04% |
| ≥ 0.95    |  6,193 | 23.42% |

**The threshold is explicit and it is not applied at ingest.** `RECOMMENDED_CONFIDENCE_FLOOR`
is 0.6 — the same value the BBB tier uses as its match floor, so "what this pipeline is willing
to assert" is one number across both tiers. **4,550 records (17.2%) fall below it** and all
4,550 are published.

The reason for publishing them is that confidence correlates with _provider_, not with truth.
An extraction-time threshold silently varies coverage by who contributed the record, and
Overture already applies its own minimum. So `confidence` is published verbatim, a
`confidence_band` is published beside it so a consumer never re-derives bucket edges, and the
filtering decision belongs to the consumer.

## 5. Licence gate — PASS

Run twice: once on the clipped extract and again before publication. Fails closed; the
allowlist is never extended from observed data.

| Provider         | Places | Licence             |
| ---------------- | -----: | ------------------- |
| Overture         | 26,446 | CDLA-Permissive-2.0 |
| Overture-signals | 14,794 | CDLA-Permissive-2.0 |
| meta             | 14,543 | CDLA-Permissive-2.0 |
| Microsoft        |  5,063 | CDLA-Permissive-2.0 |
| BrightQuery      |  4,684 | CDLA-Permissive-2.0 |
| Foursquare       |  1,709 | Apache-2.0          |
| AllThePlaces     |    285 | CC0-1.0             |
| DAC              |    155 | CDLA-Permissive-2.0 |
| PinMeTo          |      4 | CDLA-Permissive-2.0 |
| RenderSEO        |      3 | CDLA-Permissive-2.0 |

`osm` is **absent** and is a hard stop in any casing — its share-alike terms are incompatible
with republishing this artifact, so an OSM row reaching the published Parquet would be a
licence violation rather than a data-quality problem. `krick` is approved but was not present
in Seminole. Comparison is case-insensitive; stored spellings are the providers' own, because
a published NOTICE has to name providers the way they write their own names.

## 6. Roofing businesses joined to permits and BBB

`taxonomy.hierarchy = services_and_business/home_service/ceiling_and_roofing_repair_and_service/roofing`
returns **162 records, 150 distinct names**. One sibling record under
`ceiling_and_roofing_repair_and_service/ceiling_service` is not roofing and is not counted.

Fill rates on those 162: **162 with a street address, 161 with a phone, 161 with a website**.
That is contractor contact data the permit portal does not carry.

### Measured match rates — read the denominators

The join is two fuzzy name hops and has no shared identifier at either end. Overture has no
licence number, the permit portal has no registry key, and BBB has neither.

| Measurement                                       | Result            |
| ------------------------------------------------- | ----------------- |
| Roofing places                                    | 162               |
| Permit contractor names available                 | **47**            |
| Places matched to a permit contractor (floor 0.6) | 15/162 = **9.3%** |
| — of which defensible (exact/prefix/strong)       | 8/162 = **4.9%**  |
| Permit contractors that reached a business        | 10/47 = **21.3%** |
| BBB businesses available                          | **0**             |
| Places matched to a BBB rating                    | 0/162 = **0.0%**  |

**The 47 is the constraint, not the matcher.** Those names are derived from the permit tier's
two `source-a` HTML fixtures — 63 census rows, all roofing-relevant, 47 distinct contractors,
13 of them truncated at the portal's 30-character column width. With only 47 names available,
the arithmetic ceiling on the place-side rate is 47/162 = 29%. When the full county permit
census lands, this tier reads it automatically from
`staged/permits/census/**/*.ndjson` and the denominator changes; the number above must be
re-measured, not extrapolated.

**The `weak` tier is excluded from the quoted rate on evidence.** All seven weak matches were
inspected and three are plainly different companies:

| Overture place                  | Permit contractor              | Score | Verdict                 |
| ------------------------------- | ------------------------------ | ----- | ----------------------- |
| All Roofing & Construction      | ALL ROOFING & CONSTRUCTION CO  | 1.000 | correct                 |
| Collis Roofing Inc.             | COLLIS ROOFING INC (LANIER-CCC | 1.000 | correct                 |
| Central Florida Equity Builders | CENTRAL FLORIDA EQUITY (CCC) B | 0.968 | correct                 |
| Fleming Brothers Roofing        | FLEMING BROTHERS ROOF(RC MICHA | 0.756 | correct but scored weak |
| Certified Best Roofing          | BEST PRICE ROOFING(CCC) INC    | 0.660 | **wrong**               |
| Top Notch Roofing               | TIP TOP ROOFING CO INC (GOLDMA | 0.649 | **wrong**               |
| Mid Florida Roofing             | MID FLORIDA EXTERIORS LLC      | 0.619 | **wrong**               |

Overture roofing names and permit contractor names are dense in the same handful of words, so
bigram agreement in the 0.60–0.80 band is mostly two different roofers sharing a vocabulary.
The rows are still emitted with their tier and score attached — a consumer wanting recall can
take them — but `defensibleMatchRate` is the number to quote.

**BBB is 0% because there is no BBB data on disk yet, not because the join fails.** The BBB
tier's harvest output (`staged/bbb/businesses/**` and `staged/bbb/contractor-ratings/**`) had
not been produced when this was measured. The join is implemented against that tier's exact
`BbbBusinessRecord` and `ContractorRatingMatch` contracts and unit-tested; re-running
`cli.ts ingest` after their harvest lands produces the measured rate with no code change.

A rating reached through a permit contractor carries `bbbPath: 'via_permit_contractor'` and a
**compounded** confidence (the product of both hops), because a rating reached through two
fuzzy matches cannot be presented with the confidence of one. A rating shown against a
contractor's name is a factual claim about a real business.

### Why this reuses the BBB tier's matcher

`normalizeBusinessName` and `similarity` are imported from `../bbb/normalize` rather than
reimplemented. That matcher already encodes two things measured off the real permit column —
the 30-character truncation and the `(CCC)` licence-qualifier parenthetical — and a second
matcher here would inevitably disagree with it. Two tiers reporting different match rates for
the same pair of names is worse than a coupling. Nothing under `src/bbb/` is modified.

## 7. Ongoing ingestion, measured rather than asserted

Both retained releases were extracted and diffed by GERS id. This is a real
release-over-release delta, not a simulated one:

| `2026-07-22.0` → `2026-08-19.0` |    Records |
| ------------------------------- | ---------: |
| Previous release, clipped       |     23,861 |
| Added                           |     +3,253 |
| Removed                         |       −668 |
| Changed (published fields)      |      8,869 |
| Unchanged                       |     14,324 |
| **Current release, clipped**    | **26,446** |

Roofing went 159 → 162 over the same month.

`removed` is **not** business closure and must never be rendered as one — a provider can drop
a record for its own reasons. Overture states closure explicitly in `operating_status`:
**17,205 open, 845 permanently_closed, 8,396 unknown**.

Rows carry `first_seen_release`, `last_seen_release` and `is_current`, upserted on GERS id.
Because only two releases are retained upstream, `first_seen_release` cannot look back further
than one release; it is honest about what it knows rather than defaulting to the current one.

### Change detection: content fingerprint, not bytes

The brief requires a fetch timestamp on every record, and that requirement is at odds with
byte-identical output — two runs an hour apart over an unchanged release differ in every row,
so the Parquet bytes and the CID differ, and a publish step comparing bytes would re-upload
2.4 MB nightly for no change.

So change detection uses a `contentFingerprint` computed over the observable content with
`fetched_at` excluded. Verified across two independent full runs:

```
run 1  content sha 04c7e32069f60b141684b530abaa4557   parquet 2,433,177 bytes
run 2  content sha 04c7e32069f60b141684b530abaa4557   parquet 2,430,511 bytes
```

Identical fingerprint, different bytes. The fingerprint is the correct key for "nothing
changed"; the deterministic single-threaded ordered write still matters, because it is what
makes row-group pruning and range requests work over a gateway.

## 8. Output location and shape

Keys are identical local and on S3, so choosing a sink is a deployment detail:

```
raw/places/boundary/layer={county,places}/vintage=2025-01-01/<sha16>.geojson
staged/places/business-locations/release=2026-08-19.0/jurisdiction=<name>/*.parquet
staged/places/roofing-matches/release=2026-08-19.0/matches.ndjson
publish/places/business-locations/release=2026-08-19.0/places.parquet
publish/places/current.json
manifests/places/<runId>/summary.json        # counts, gate, delta, provenance
manifests/places/<runId>/roofing-join.json   # match rates and their denominators
```

A local run mirrors this under `.places-work/` (gitignored — extracted place data is never
committed).

**For UI agents:** read `publish/places/business-locations/release=<release>/places.parquet`.
One row per business, 26,446 rows, 34 columns, ZSTD, 20,000-row row groups, sorted by
`(jurisdiction, geohash5, gers_id)`.

| Column                                                                       | Type            | Notes                                                 |
| ---------------------------------------------------------------------------- | --------------- | ----------------------------------------------------- |
| `gers_id`                                                                    | varchar         | Overture GERS id. Stable identity and the upsert key. |
| `name`                                                                       | varchar         | Business name.                                        |
| `taxonomy_primary`                                                           | varchar         | Most specific current label, e.g. `roofing`.          |
| `taxonomy_hierarchy`                                                         | varchar         | `/`-delimited path. **Key category logic on this.**   |
| `taxonomy_alternates`                                                        | varchar[]       | Not primary-category membership.                      |
| `basic_category`                                                             | varchar         | Coarse label for map display.                         |
| `legacy_category_primary`                                                    | varchar         | Deprecated. Compatibility only; do not key on it.     |
| `confidence`                                                                 | double          | 0–1, as published. Never used to drop a row.          |
| `confidence_band`                                                            | varchar         | Pre-bucketed, e.g. `0.90-0.95`.                       |
| `latitude`, `longitude`                                                      | double          | For radius queries.                                   |
| `geohash5`                                                                   | varchar         | Same partition key the parcel snapshot uses.          |
| `jurisdiction`                                                               | varchar         | Geometric. Same vocabulary as the parcel snapshot.    |
| `jurisdiction_geoid`                                                         | varchar         | TIGER place GEOID, null when unincorporated.          |
| `address_freeform`, `address_locality`, `address_postcode`, `address_region` | varchar         | As published.                                         |
| `locality_matches_jurisdiction`                                              | boolean         | False for the 1,628 postal disagreements.             |
| `operating_status`                                                           | varchar         | `open` / `permanently_closed` / null.                 |
| `websites`, `phones`, `emails`, `socials`                                    | varchar[]       | Public business contact data.                         |
| `brand_name`                                                                 | varchar         |                                                       |
| `source_datasets`, `source_licenses`                                         | varchar[]       | Provider lineage, source spelling.                    |
| `overture_release`, `source_url`, `fetched_at`                               | varchar         | Provenance, on **every** row.                         |
| `first_seen_release`, `last_seen_release`, `is_current`                      | varchar/boolean | Lifecycle.                                            |

One gotcha: reading the file by its local path makes DuckDB synthesise a `release` column from
the `release=` path segment via hive-partition auto-detection. **`overture_release` is the
authoritative in-file column**; a consumer fetching over HTTP will not get `release`.

`staged/places/roofing-matches/**/matches.ndjson` holds the 162 roofing rows with
`permitMatched`, `permitMatchTier`, `permitMatchConfidence`, `bbbMatched`, `bbbPath`,
`bbbRating` and `bbbMatchConfidence`. A consumer that renders a BBB grade without also
rendering the two confidences is choosing to hide how it got there.

## 9. The DuckDB demo path

This tier is genuinely DuckDB-driven — the extract, the clip, the licence gate and the write
are all DuckDB — so the query a presenter runs uses the same engine that wrote the file.

Build it (about 45 seconds, or 93 with the release diff):

```sh
pnpm exec tsx apps/api/src/places/cli.ts ingest --diff
```

Print the demo query, resolved against the artifact actually on disk:

```sh
pnpm exec tsx apps/api/src/places/cli.ts demo
```

**The command for the walkthrough** — roofing contractors by jurisdiction, straight out of the
published Parquet with no server in the picture:

```sh
duckdb -c "
SELECT jurisdiction, name, address_freeform, round(confidence, 3) AS confidence
FROM read_parquet('.places-work/publish/places/business-locations/release=2026-08-19.0/places.parquet')
WHERE taxonomy_hierarchy = 'services_and_business/home_service/ceiling_and_roofing_repair_and_service/roofing'
  AND confidence >= 0.6
ORDER BY confidence DESC LIMIT 20;"
```

Verified output:

```
┌────────────────────────────────┬─────────────────────────────┬──────────────────────────────┬────────────┐
│          jurisdiction          │            name             │       address_freeform       │ confidence │
├────────────────────────────────┼─────────────────────────────┼──────────────────────────────┼────────────┤
│ Sanford                        │ Advanced Roofing Inc.       │ 200 Northstar Ct             │ 0.99       │
│ Altamonte Springs              │ Secured Roofing & Solar     │ 483 Montgomery Pl Ste 104    │ 0.989      │
│ Longwood                       │ All Roofing & Construction  │ 1490 W State Rd 434, Ste 108 │ 0.983      │
│ Unincorporated Seminole County │ Roofing Pros USA            │ 7100 S US Highway 17 92      │ 0.98       │
│ Unincorporated Seminole County │ Johnson Roofing Orlando Inc │ 405 Ruth St                  │ 0.974      │
└────────────────────────────────┴─────────────────────────────┴──────────────────────────────┴────────────┘
```

"Total uploaded records by source" for this source is one line:

```sh
duckdb -c "
SELECT any_value(overture_release) AS release, count(*) AS business_records,
       count(DISTINCT jurisdiction) AS jurisdictions, max(fetched_at) AS collected_at
FROM read_parquet('.places-work/publish/places/business-locations/release=2026-08-19.0/places.parquet');"
```

And the source can be queried straight from open data with no local artifact at all, which is
the cost argument in one statement:

```sh
duckdb -c "
INSTALL httpfs; LOAD httpfs; SET s3_region='us-west-2';
SELECT count(*) FROM read_parquet('s3://overturemaps-us-west-2/release/2026-08-19.0/theme=places/type=place/*.parquet')
WHERE bbox.xmin BETWEEN -81.459728 AND -80.986868 AND bbox.ymin BETWEEN 28.610501 AND 28.879227;"
```

### Requested `justfile` recipes

The `justfile` is owned elsewhere, so these are not added here. Requested verbatim:

```make
# Ingest Overture business places for Seminole County, with a release-over-release diff
places-ingest:
    pnpm exec tsx apps/api/src/places/cli.ts ingest --diff

# Print the DuckDB command for the business-places demo, resolved against the built artifact
places-demo:
    pnpm exec tsx apps/api/src/places/cli.ts demo
```

## 10. Cost and performance

| Property                    | Measurement                                                    |
| --------------------------- | -------------------------------------------------------------- |
| Requests to Overture        | Parquet range reads only; no listing beyond one release prefix |
| Requests to Census TIGERweb | 2 per run (108 KB + 1.45 MB)                                   |
| Extract, one release        | 45 s                                                           |
| Extract with diff           | 93 s (two full-theme scans)                                    |
| Peak local memory           | bounded by ~31,000 pruned rows, not by the theme               |
| Published artifact          | 2.43 MB                                                        |
| Standing infrastructure     | **none**                                                       |

No CDK construct was added, deliberately. This source refreshes monthly, needs no credentials,
and finishes in under two minutes; wiring it behind an always-on API or a warm cluster would
add exactly the fixed cost this milestone is meant to avoid. It runs from an operator shell, a
CI job, or a scheduled container, all of which cost nothing when idle. If a scheduled AWS
execution is later wanted, a Glue Python-shell job on an EventBridge monthly rule is the
cheapest shape at roughly $0.44 per run at the measured runtime — but that is a decision to
take on purpose, not a default.

No source is slow or throttled here. Overture is object storage and TIGERweb answered both
queries in under 7 seconds. That makes this the fastest source in the pipeline and a useful
contrast to the permit portal's ~2.3 s per permit.

## 11. Limitations

- **Permit match rate is denominator-bound at 47 contractor names.** Re-measure against the
  full county census; do not extrapolate.
- **BBB match rate is 0% because BBB output did not exist on disk when measured.** The join is
  implemented and tested, not verified end to end against real BBB rows.
- **`first_seen_release` cannot look back beyond one release** because Overture retains only
  two. It is honest about that rather than guessing.
- **No parcel-level link.** Businesses carry `geohash5` and `jurisdiction`, so a spatial or
  jurisdictional join to parcels is available, but no confidence-scored business-to-parcel
  bridge is populated. That is deliberately out of scope for ingest.
- **Overture is a numerator, not a denominator.** 26,446 is what Overture knows about, not how
  many businesses exist in Seminole County. Any coverage figure derived from it should record
  an expected count of `NULL` rather than manufacture 100% completion.
- **`emails` and `phones` are published as-is.** They are public business contact details
  rather than personal data, consistent with the equivalent decision recorded for Lee County,
  but it is a decision and it is recorded here.
- **IPFS publication is not wired.** The artifact is built in the layout the publish tier
  expects; uploading it and pointing an IPNS name at it belongs to that tier.
