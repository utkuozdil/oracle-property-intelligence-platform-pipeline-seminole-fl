# Seminole County FL — BBB Contractor Reputation Findings

**Question:** can BBB contractor ratings be harvested with plain HTTP, or does BBB require a
headless-browser tier?

**Answer: plain HTTP. No browser, no Chromium, no challenge solving.**

**This reverses an earlier conclusion recorded in this project.** BBB enrichment was cut on the
grounds that the site was bot-protected and would need a Chromium tier that the pipeline had
deliberately removed. That conclusion was never tested against a live response. It is wrong.
`curl` with a browser User-Agent gets HTTP 200 and the complete result set, first try, no
cookies, no session, no challenge. The section [Why the earlier conclusion was
wrong](#why-the-earlier-conclusion-was-wrong) explains exactly what produced the false
positive, because the same two strings are still in every successful response and will mislead
the next person who greps for them.

Every claim below is backed by a live response captured on **2026-09-01**, and by a full harvest
run of 152 requests made the same day. Two of those responses are committed as test fixtures in
`apps/api/src/bbb/__fixtures__/`.

## Table of contents

- [Verdict summary](#verdict-summary)
- [Why the earlier conclusion was wrong](#why-the-earlier-conclusion-was-wrong)
- [Exact working request shape](#exact-working-request-shape)
- [Where the data actually is](#where-the-data-actually-is)
- [Fields available](#fields-available)
- [Traps](#traps)
- [Measured throughput and politeness](#measured-throughput-and-politeness)
- [Coverage achieved](#coverage-achieved)
- [Match rate against permit contractors](#match-rate-against-permit-contractors)
- [Output location and shape](#output-location-and-shape)
- [Limitations](#limitations)
- [Open questions](#open-questions)

## Verdict summary

| Question | Answer |
| --- | --- |
| Browser required? | **No.** Plain HTTPS GET, no cookies, no JS execution. |
| Challenge / CAPTCHA encountered? | **No**, across 152 requests at ~1 req/s. |
| Rate limiting encountered? | **No**, at ~1 req/s. Ceiling not probed. |
| Records per request | 15 |
| Hard ceiling per search term | **225** (15 pages × 15), regardless of stated total |
| Businesses harvested | **437** distinct (350 flagged roofing) |
| Permit contractors matched | **37 of 47 (78.7%)** |
| Wall clock, cold run | 152 requests in 258 s |
| Wall clock, re-run | 0 requests, 0.1 s (served from ledger) |

## Why the earlier conclusion was wrong

A successful BBB search response contains **both** of these:

- the literal string `captcha`
- a `<script>` tag referencing `/cdn-cgi/challenge-platform/`

Neither indicates a challenge. They are part of Cloudflare's client bootstrap and of BBB's own
page furniture, and they are present on every 200 that carries a complete result set. Grepping a
saved response for `captcha` or `challenge` therefore returns a hit on a page that worked
perfectly, which is the most likely way the earlier "bot-protected" finding was reached.

This tier consequently does **not** screen response bodies for block markers, which is the
opposite of what the permit tier does — the permit portals announce a block in the body and are
screened for it. Here, a response is judged by whether it contains a parseable result payload
(`MissingResultPayloadError`), plus the HTTP status. The reasoning is recorded in
`apps/api/src/bbb/config.ts` next to `BLOCK_STATUSES`, and asserted by a test that pins both
false-positive markers as present in a known-good fixture, so nobody re-derives the wrong
conclusion from a grep.

**No browser tier is needed and none was added.** Nothing in this pipeline requires Chromium.

## Exact working request shape

```
GET https://www.bbb.org/search
      ?find_country=USA
      &find_loc=<City>%2C%20FL
      &find_text=<term>
      &page=<n>

User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36
Accept: text/html,application/xhtml+xml,...
```

- `find_text` matches **both** business names and BBB category names, which is why one endpoint
  serves both the category seed sweep and the per-contractor name lookup.
- No cookie, session, referer, or token is required. A first request from a cold client works.
- A default `curl`/`node` User-Agent was not relied on; a realistic browser agent is set as a
  matter of manners on a public site being read by a robot.
- Response is ~156–222 KB of HTML.

## Where the data actually is

Not in the rendered markup in any parseable form. The results are the JSON the React app
hydrates from, assigned inline in the document head:

```
window.__PRELOADED_STATE__ = { "user": {...}, "page": {...}, "searchResult": {...} };
```

`searchResult` carries `page`, `pageSize`, `totalPages`, `totalResults`, and `results` — an
array of 15 business objects.

Extraction cannot be done with a regex: the payload is roughly 100 KB on a single line and the
terminating brace can only be found by tracking nesting depth and string state. The parser
(`sliceStateLiteral`) does exactly that and then `JSON.parse`s the slice, so a mis-slice fails
loudly instead of silently returning partial data.

## Fields available

Per business, confirmed present on live records:

| Field | Notes |
| --- | --- |
| `id`, `businessId` | BBB's identity. `id` is `<bbbId>_<businessId>_<n>`. |
| `businessName` | May be wrapped in `<em>` tags — see [Traps](#traps). |
| `rating` | Letter grade: `A+`, `A`, `A-`, … `F`. Absent for unrated. |
| `ratingScore` | Numeric score behind the grade. |
| `bbbMember` | Accreditation flag. |
| `address`, `postalcode` | Street address of the business. |
| `city`, `state` | **Not trustworthy** — see [Traps](#traps). |
| `reportUrl` | Profile path; encodes the real city. |
| `phone` | Array, often more than one number. |
| `tobText`, `categories[]` | Category name and id list. `10126-*` is the roofing family. |
| `serviceAreasSummary[]` | Counties served — how a roofer outside Seminole still covers it. |
| `outOfBusinessStatus` | Null for active businesses. |

Ratings come straight off the search response, so **no profile-page fetch is needed** for the
rating itself. That is what makes this tier cheap: one request yields 15 rated businesses.

## Traps

1. **`city`/`state` in the payload are not reliably the business's.** The same payload also
   carries the *requester's* geolocation (observed as `Ashburn, VA` from this egress). The
   business city is taken from the `reportUrl` path instead —
   `/us/fl/sanford/profile/roofing-contractors/…` — which cannot be anything else. This is not
   theoretical: across the 437 harvested records the payload `city` and the profile-path city
   **disagree on 102 of them (23%)**. Both are stored (`city` from the path, `payloadCity` from
   the payload) so the disagreement stays visible rather than being silently resolved.

2. **Business names come back wrapped in `<em>` tags** around the matched search term:
   `<em>JTO</em> <em>Roofing</em> and Solar`. Left in place these pollute the stored name and
   every downstream join, and the same business harvested under two search terms would produce
   two different names. Stripped on ingest.

3. **`totalResults` is not reachable.** A Sanford roofing search reports 5,791 matches and
   `totalPages: 15`. Page 16 does not exist. Any single term is capped at 225 records. Runs
   record a warning naming the term whenever the stated total exceeds what was returned, so a
   coverage figure is never read as complete when it is not.

4. **One business id can answer to two different names.** BBB returns whichever of a business's
   names matched the search, so `0733_90718872_109970` is `3MG Solutions LLC` in a category
   sweep and `3MG Roofing & Solar` in a name lookup — legal name and trade name. Deduplicating
   on id while keeping only the first name seen destroyed real matches, because a permit lists
   whichever name the contractor pulled the permit under. All names are kept (`alsoKnownAs`) and
   the matcher scores against every one of them. 5 of the 437 records carry an alias.

5. **The permit contractor column is 30 characters wide and truncates mid-word**, with no
   ellipsis, and it appends a licence qualifier that is not part of the business name. This is a
   permit-side trap rather than a BBB one, but it dominates the join — see below.

## Measured throughput and politeness

Full cold run, 2026-09-01:

| Measure | Value |
| --- | --- |
| Searches issued | 54 (7 city seeds × 15 pages, plus 47 name lookups) |
| Requests | 152 |
| Wall clock | 257.7 s |
| Effective rate | **0.59 req/s** |
| Latency | min 377 ms, median 629 ms, max 2,229 ms |
| Failures, retries, blocks | **0** |

Politeness settings: one request in flight, ~1,000 ms between requests jittered ±30%, real
browser User-Agent, 3 attempts with exponential backoff on transport errors, and **no retry at
all** on a refusal (403/429/503) — retrying into a rate limit risks the only access path this
tier has. The effective 0.59 req/s is below the 1 req/s target because the pacing delay is
applied both between pages and between searches.

The point at which BBB starts refusing was **deliberately not probed.** Finding it means getting
blocked.

### Idempotency

A second identical run made **0 requests in 0.1 s**, serving all 54 searches from the ledger and
producing byte-identical counts. The ledger (`manifests/bbb/ledger/`) is keyed on the search URL
rather than on the run, holds the parsed records, and has a 30-day freshness window — chosen
because a BBB letter grade moves on the order of months. So the harvest can be re-run as more
permits land and will only pay for contractors it has not seen. The ledger also carries a schema
version, so changing the record shape invalidates it rather than deserializing an old shape into
a new type.

## Coverage achieved

| Measure | Value |
| --- | --- |
| Distinct businesses | **437** |
| Flagged roofing (category `10126-*` or roofing in category name) | **350** |
| BBB-accredited | 338 |
| Marked out of business | 0 |
| Distinct cities represented | 95 |
| In Seminole County and immediately adjacent cities | 119 |
| From the 7-city seed sweep | 275 |
| From per-contractor name lookups | 162 |

**Scope was kept deliberately tight.** This is not a crawl of every Seminole County business. It
is (a) a roofing seed sweep across the seven Seminole municipalities, and (b) one name lookup per
contractor that actually appears on harvested permits. Businesses in the pool from other cities
are there because BBB's location search has a generous radius and because roofers serve whole
counties — `serviceAreasSummary` on many records explicitly lists Seminole County.

## Match rate against permit contractors

**37 of 47 distinct permit contractor names matched, a measured match rate of 78.7%.**

Contractor names were taken from the permit tier's Source A census output. The permit harvest was
still running when this was measured, so the 47 names come from the census HTML fixtures
committed in `apps/api/src/permits/__fixtures__/` — real Seminole permit rows, but **a sample,
not the finished census.** When the permit harvest completes, the harvest re-runs against the
full contractor list and pays only for the new names.

Confidence tiers, and what each one actually is:

| Tier | Count | Meaning |
| --- | --- | --- |
| `exact` | 31 | Normalized names identical. |
| `truncated_prefix` | 2 | Permit name cut at 30 chars; BBB name continues it exactly. |
| `strong` | 3 | Permit name fully contained in the BBB name, on a distinctive token. |
| `weak` | 1 | Above the floor on genuine token overlap, stated as weak. |
| unmatched | 10 | No candidate cleared the 0.6 floor. |

**All 37 claimed matches were inspected by hand and all 37 are correct.** That is a review of
this specific run, not a general precision guarantee.

Rating distribution **of the matched permit contractors** — the number the UI will actually show:

| Grade | Contractors |
| --- | --- |
| A+ | 30 |
| A | 4 |
| A- | 2 |
| unrated | 1 |

Rating distribution across all 437 harvested businesses: A+ 342, A 34, A- 23, B- 1, C- 1, D- 9,
F 1, unrated 26. **This distribution is biased and should not be read as "Seminole roofers are
excellent."** BBB's search ranks accredited businesses first, and a 15-page ceiling means the
sweep sees the top of that ranking — 338 of 437 records are accredited. It is a sample of what
BBB surfaces, not a census of the trade.

### Why the match rate is not higher, honestly

The join is fuzzy and imperfect by nature, and two properties of the permit portal cause almost
all of the difficulty:

- **30-character truncation.** 13 of the 47 names are exactly 30 characters. Nine of those turn
  out to be complete business names whose *licence qualifier* was cut; four had the business
  name itself cut. Distinguishing the two cases mattered — treating every 30-character name as
  cut made `NATIONS ROOF RESIDENTIAL LLC(B` search BBB for `NATIONS ROOFING`, dropping the one
  token that identified the business.
- **Licence qualifiers.** 24 of 47 names carry a parenthetical like `(CCC)`, `(CCC-ANGIULLI)`,
  `(HOOD CCC)`, `(LANIER-CCC` — the Florida certified-roofing licence prefix and the qualifying
  agent's surname. Not part of the business name, frequently left unbalanced by truncation, and
  sometimes spliced into the middle of a word (`CONST(CCC)RU` is `CONSTRU` interrupted).

The 10 unmatched names are reported rather than padded. Four returned candidates that overlapped
only on generic industry words and were refused (see below); the rest returned nothing usable
from BBB — `ABARCA INC`, `GRASCO INC (CCC)`, `QUALITY LABOR SOURCE LLC` — and are most likely
simply not listed with BBB, which is a fact about the businesses, not a defect in the harvest.

### The rule that keeps the match rate honest

An earlier version of the matcher reported **85.1%**. That number was inflated. Three of its
matches were wrong about a real business:

| Permit contractor | Claimed BBB match | Confidence |
| --- | --- | --- |
| `BLITZ ROOFING & CONSTRUCTION` | "HC Roofing & Construction" | 0.79 |
| `GREENTEK ROOFING & SOLAR` | "JTO Roofing and Solar" | 0.74 |
| `BARBER & ASSOCIATES INC` | "Crespo & Associates" | 0.67 |

Each cleared the confidence floor on overlap made up **entirely** of industry vocabulary —
`ROOFING`, `CONSTRUCTION`, `SOLAR`, `ASSOCIATES`. That is evidence that both parties are roofing
companies, not evidence that they are the same company. The matcher now requires at least one
shared token that actually names the business, which dropped all three errors and kept the true
positive in that group (`FLEMING BROTHERS ROOF` → "Fleming Brothers Roofing"). The reported rate
fell from 85.1% to 78.7%.

**78.7% with 37 correct matches is the honest number, and it is better than 85.1% with three
false statements about named businesses.** A wrong rating displayed against a contractor's name
is a factual claim about a real company. Every match therefore carries `confidence`, `matchTier`,
`bbbMatchedName` (the name the match was made on, which may be an alias), and `runnerUpCount`
(how many other candidates also cleared the floor), so a consumer that wants to show only what
it can defend can filter, and unmatched contractors keep their best score for review.

## Output location and shape

**For the UI and CRM agents: read the pointer, follow it to the matches file.**

| Purpose | Key |
| --- | --- |
| **Stable pointer** — start here | `staged/bbb/contractor-ratings/current.json` |
| Contractor → rating join (NDJSON) | `staged/bbb/contractor-ratings/run=<runId>/matches.ndjson` |
| All harvested businesses (NDJSON) | `staged/bbb/businesses/run=<runId>/businesses.ndjson` |
| Run counters | `manifests/bbb/<runId>/summary.json` |
| Unmatched contractors + best candidate | `manifests/bbb/<runId>/unmatched.json` |
| Raw search HTML (provenance) | `raw/bbb/search/loc=<city>/term=<slug>-<hash>/run=<runId>/page-NNNN.html` |
| Idempotency ledger | `manifests/bbb/ledger/<xx>/<sha256>.json` |

`current.json` is written **last**, after the run's own outputs, so a reader following it is never
sent to a partially written run:

```json
{
  "runId": "seminole-bbb-2026-09-01",
  "generatedAt": "2026-09-01T15:21:14.277Z",
  "businessesKey": "staged/bbb/businesses/run=seminole-bbb-2026-09-01/businesses.ndjson",
  "matchesKey": "staged/bbb/contractor-ratings/run=seminole-bbb-2026-09-01/matches.ndjson",
  "summaryKey": "manifests/bbb/seminole-bbb-2026-09-01/summary.json",
  "businessCount": 437,
  "matchedContractorCount": 37,
  "matchRate": 0.7872
}
```

One line of `matches.ndjson` — this is the record to render:

```json
{
  "permitContractorName": "COLLIS ROOFING INC (LANIER-CCC",
  "permitContractorKey": "COLLIS ROOFING",
  "permitNameTruncated": false,
  "permitCount": 2,
  "matched": true,
  "matchTier": "exact",
  "confidence": 1,
  "runnerUpCount": 6,
  "bbbRecordId": "0733_102052_842",
  "bbbBusinessName": "Collis Roofing, Inc.",
  "bbbMatchedName": "Collis Roofing, Inc.",
  "rating": "A+",
  "ratingScore": 100,
  "accredited": true,
  "city": "Longwood",
  "state": "FL",
  "phones": ["(321) 441-2300"],
  "profileUrl": "https://www.bbb.org/us/fl/longwood/profile/roofing-contractors/collis-roofing-inc-0733-102052",
  "sourceUrl": "https://www.bbb.org/search?find_country=USA&find_loc=Sanford%2C+FL&find_text=Roofing+Contractors&page=3",
  "fetchedAt": "2026-09-01T15:08:18.338Z"
}
```

There is **one line per permit contractor**, matched or not. An unmatched line has
`matched: false`, `rating: null`, and `confidence` set to the best score reached — so a consumer
can distinguish "no BBB rating exists" from "we could not confidently identify the business",
which are different things to show a user.

Rendering guidance:

- Show a rating for `matched: true`. For `matchTier` of `weak`, or a non-zero `runnerUpCount`,
  attribute it (e.g. "likely match") or hide it — the data supports either choice, and both are
  more honest than presenting a weak match as fact.
- `bbbMatchedName` differing from `bbbBusinessName` is normal and worth surfacing: it means the
  permit used the trade name and BBB lists the legal name.

Both the raw HTML and the parsed records carry `fetchedAt` and `sourceUrl`, so every displayed
rating is attributable to a specific response at a specific instant.

## Limitations

1. **225 records per search term, hard.** Coverage grows by adding *searches* — narrower terms,
   more cities, more contractor names — never by adding pages. Any per-term shortfall is recorded
   as a run warning.
2. **The contractor list is a sample, not the full census.** The permit harvest had not finished;
   47 names came from committed permit fixtures. The match rate is measured against those 47.
   When the census completes, re-running extends coverage at the cost of only the new lookups.
3. **The rating distribution is accredited-biased** (338 of 437). BBB ranks accredited
   businesses first and the page ceiling truncates the ranking. Do not read it as a survey of
   the trade.
4. **Name matching is fuzzy and stays fuzzy.** 78.7% on this sample, hand-verified for this run.
   The floor is deliberately conservative; raising it would raise the rate and lower the truth.
5. **No profile-page enrichment.** Complaint counts, review text, accreditation dates, and years
   in business are on the profile page, not the search response. Not fetched — the rating was
   the acceptance criterion, and a profile fetch per business would multiply the request count.
6. **Metrics use the `Artifact` noun.** `METRIC_ITEMS` has no contractor/reputation noun, and
   adding one means editing `packages/shared/src/metrics.ts` and the `observability/metrics.json`
   staging manifest, both owned outside this tier.
7. **`BbbStack` is not registered in `cdk/bin/app.ts`.** `PermitStack` is in the same state, and
   `app.ts` was being edited concurrently. Registration is a single statement, quoted at the
   bottom of `apps/api/cdk/lib/bbb-stack.ts`. Nothing was deployed.

## Open questions

- Do narrower category terms (`Tile Roofing Contractors`, `Metal Roofing`, `Commercial Roofing`,
  each its own `10126-*` sub-code) get past the 225-per-term ceiling by partitioning the result
  set? If so, seed coverage can grow substantially at ~15 requests per term.
- Is there a stable JSON endpoint behind the search page? The payload shape suggests an internal
  API. Worth a look only if request volume ever becomes a constraint; at 152 requests it is not.
- Should the `weak` tier be surfaced to users at all, or held for operator review? This is a
  product call, and the data supports either.
- Where do BBB ratings join in the Python/Glue tier so they reach the published query table?
  Today this tier lands staged NDJSON and a stable pointer; the Glue-side join onto the parcel
  and permit schema is not written, and is the natural next step.

## Reproducing

```bash
BBB_LOCAL_DIR=.bbb-work/out \
  pnpm --filter @oracle-seminole/api exec tsx src/bbb/run-local.ts \
    --run-id seminole-bbb-2026-09-01 \
    --seed-pages 15 \
    --contractors <contractor-list.json>
```

Runs against a local directory with no AWS account involved; the keys written are identical to
the S3 keys. Omit `BBB_LOCAL_DIR` and set `DATA_BUCKET` to write to the data bucket. Omit
`--contractors` to read names from the staged permit census instead.
