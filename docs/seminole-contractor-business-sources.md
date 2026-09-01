# Seminole County — Contractor & Business Source Feasibility

Research-only investigation of the two remaining unproven data sources: DBPR contractor
licenses and Sunbiz corporate registrations. All findings below were observed directly
against the live hosts on 2026-09-01; nothing here is inferred from documentation.

---

## Verdict: the Chromium container-image tier can be dropped

**Yes — delete it.** DBPR's 48.8 MB construction license CSV was downloaded end to end
over plain HTTP with `curl`, no browser, no JavaScript execution, no challenge solving.
The file parsed cleanly into 271,941 complete records.

The Cloudflare managed challenge that blocked the earlier attempt is real, but it does
**not** need to be solved. Cloudflare emits a `__cf_bm` cookie _along with_ the 403
challenge response. Replaying that cookie on the CSV path returns `200`. The challenge
gates HTML pages only; the static CSV asset is satisfied by the bot-management cookie
alone.

Combined with this afternoon's finding that both permit portals work over plain HTTP,
**no remaining source in this pipeline requires a browser.** The container-image Lambda
with Chromium + Playwright has no remaining consumer.

Because plain HTTP succeeded, I did not spend time verifying Playwright as a fallback —
there is no fallback to justify.

The one caveat, detailed under [Rate limiting](#rate-limiting-real-but-manageable), is
that the host throttles aggressively. That is a retry/pacing concern, not a browser
concern.

---

## Source 1 — DBPR contractor licenses

| Property         | Finding                                                                  |
| ---------------- | ------------------------------------------------------------------------ |
| Reachable        | Yes                                                                      |
| Browser required | **No** — proven, full file downloaded with `curl`                        |
| Transport        | HTTPS, two requests (cookie prime + file GET)                            |
| File size        | 48,780,751 bytes (confirmed via `Content-Range`)                         |
| Records          | 271,941 (100% parsed at exactly 22 fields, zero ragged rows)             |
| Seminole records | 5,211 (county code `69`)                                                 |
| Refresh cadence  | Daily — `Last-Modified: Tue, 01 Sep 2026 10:48:27 GMT`, ~2h before fetch |
| Range requests   | Supported (`206`), so downloads are resumable                            |
| Effort estimate  | **0.5–1 day**                                                            |

### The exact working request

Two requests. The first is _expected_ to return 403 — that is not a failure, it is how
the cookie is obtained.

```bash
UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'

# 1. Prime: returns HTTP 403 challenge AND Set-Cookie: __cf_bm
curl -c jar.txt -A "$UA" 'https://www2.myfloridalicense.com/sto/file_download/'

# 2. Fetch with that cookie: returns HTTP 200, text/csv
curl -b jar.txt -A "$UA" \
     -H 'Referer: https://www2.myfloridalicense.com/sto/file_download/' \
     -o CONSTRUCTIONLICENSE_1.csv \
     'https://www2.myfloridalicense.com/sto/file_download/extracts/CONSTRUCTIONLICENSE_1.csv'
```

What I established about the cookie flow, by elimination:

- **The cookie is required.** Without it the CSV path returns 403 with both a browser UA
  and a default `curl` UA.
- **The realistic User-Agent is _not_ required.** Once primed, a literal `curl/8.7.1` UA
  also returns 200. A browser UA is still worth sending for consistency with the rest of
  the project, but it is not what makes this work.
- **The full browser header set is not required.** `Accept`, `sec-ch-ua`, `sec-fetch-*`
  and friends made no difference. Header fingerprinting is not the gate.
- **Any path on the host works for priming** — the listing page and the bare host root
  both yield a usable `__cf_bm`.
- **`HEAD` never succeeds**, cookie or not. Use a `Range: bytes=0-0` GET to cheaply probe
  size and `Last-Modified`.
- **The HTML listing page is never accessible**, even with the cookie. The directory
  cannot be enumerated, so filenames must be hardcoded or discovered elsewhere.

### Rate limiting: real, but manageable

Roughly 20 requests in a few minutes caused Cloudflare to escalate: the 403 responses
stopped including `Set-Cookie: __cf_bm` entirely, and previously-valid cookies stopped
working. This was **not** permanent — after a ~150 second pause the exact same flow
returned `206` immediately.

Implications for ingestion:

- Pace requests and insert a short delay (~3 s) between prime and fetch.
- Treat a 403 lacking `Set-Cookie` as "throttled, back off and retry", distinct from
  "challenge, use the cookie".
- Retry with exponential backoff. Since this is a once-daily single-file download, the
  natural request volume is ~2 requests/day, far below the escalation threshold.

### Do not use `CONSTRUCTIONLICENSE_2.csv`

A sibling file `CONSTRUCTIONLICENSE_2.csv` exists (14,739,733 bytes) but its
`Last-Modified` is **2019-10-12** — a stale legacy artifact that has not been refreshed in
seven years. Only `CONSTRUCTIONLICENSE_1.csv` is live. `CONSTRUCTIONLICENSE_0.csv` returns 301.

`_1` ends with a complete, well-formed final record, so it is not a truncated shard of a
split set.

### Record layout

**There is no header row** — the first line is already data. Field names below are derived
from the observed values, not from a published layout. 22 comma-delimited, fully
quoted fields; embedded commas occur inside quoted values (names are `LAST, FIRST M`), so
a real CSV parser is mandatory. Encoding is latin-1 compatible.

| #   | Field                   | Fill  | Example                               | Notes                                   |
| --- | ----------------------- | ----- | ------------------------------------- | --------------------------------------- |
| 0   | Board code              | 100%  | `06`                                  | Constant — always `06` (construction)   |
| 1   | License type prefix     | 100%  | `CBC`, `CGC`, `QB`                    | 29 distinct values                      |
| 2   | Individual name         | 100%  | `WALTERS, DENNIS D`                   | **Business name for `QB` rows**         |
| 3   | Business / DBA name     | 49.6% | `BUILDING CONCEPTS OF TAMPA BAY, LLC` | Literal `INDIVIDUAL` used as a sentinel |
| 4   | Licence class/qualifier | 8.0%  | `B`, `A`, `GLZ`                       |                                         |
| 5   | Address line 1          | 99.0% | `6635 GLENCOE DRIVE`                  |                                         |
| 6   | Address line 2          | 6.8%  | `SUITE 106`                           |                                         |
| 7   | Address line 3          | 0.6%  |                                       | Dirty — holds stray state/attn values   |
| 8   | City                    | 99.0% | `TAMPA`                               | Some trailing whitespace                |
| 9   | State                   | 99.0% | `FL`                                  | 65 distinct; not FL-only                |
| 10  | ZIP                     | 99.0% | `33617`, `33558-2864`                 | Mixed 5 and ZIP+4                       |
| 11  | **County code**         | 97.2% | `69` = Seminole                       | Numeric code, not a name                |
| 12  | License serial          | 53.2% | `0006231`                             | Zero-padded; blank for all `QB`         |
| 13  | **Primary status**      | 100%  | `C` / `S` / `P`                       |                                         |
| 14  | **Secondary status**    | 47.7% | `A` / `I` / blank                     |                                         |
| 15  | Original licensure date | 99.6% | `01/03/1980`                          | `MM/DD/YYYY`, years 1920–2026           |
| 16  | Status effective date   | 100%  | `09/16/2024`                          |                                         |
| 17  | **Expiration date**     | 46.1% | `08/31/2028`                          |                                         |
| 18  | —                       | 0%    |                                       | Always empty                            |
| 19  | —                       | 0%    |                                       | Always empty                            |
| 20  | **Full license number** | 53.2% | `CBC006231`                           | Prefix + serial; blank for all `QB`     |
| 21  | —                       | 0%    |                                       | Always empty                            |

Status code meanings, inferred from distribution (`C` = 271,434, `S` = 283, `P` = 224 and
`A` = 114,770, `I` = 14,977):

- Primary `C` almost certainly _Current_, with `S` and `P` as suspended/pending variants.
- Secondary `A`/`I` = Active / Inactive.

Note this extract appears to contain **only current-ish licences** — there are no
closed, revoked, or null-and-void records. It is a current-licensee snapshot, not licence
history. Do not treat absence from this file as evidence of a revoked licence.

### The `QB` problem — read this before designing the match

`QB` ("qualified business") rows are **127,368 of 271,941 records — 46.8% of the file**,
and they behave completely differently:

- **No license number at all** (fields 12 and 20 are blank for 100% of `QB` rows).
- **No expiration date.**
- **Field 2 holds the business name**, not an individual's name.

Every one of the other 144,573 non-`QB` rows has a license number, 100% of the time.

So the file is really two datasets stacked together. For licence-status enrichment the
usable population is the non-`QB` rows. `QB` rows are still useful as a contractor
business-name dictionary, but they cannot carry status or expiry.

Consequence for the permit-contractor match: the business name you match against lives in
**field 3 for non-`QB` rows and field 2 for `QB` rows**. A naive single-column match will
silently miss roughly half the data.

### Seminole County (code `69`) breakdown

Confirmed as Seminole by address: 87.6% of code-`69` rows sit in Seminole municipalities
(Longwood 1,032, Sanford 910, Oviedo 747, Altamonte Springs 562, Lake Mary 515, Winter
Springs 456, Casselberry 318). No other county code comes close.

| Metric                                   | Count |
| ---------------------------------------- | ----- |
| Total rows                               | 5,211 |
| `QB` (no licence number)                 | 2,498 |
| Non-`QB` (licence number present)        | 2,713 |
| Non-`QB` missing expiration              | 319   |
| Non-`QB` with business/DBA name          | 2,242 |
| Distinct matchable business-name strings | 3,250 |

Top licence types: `QB` 2,498, `CGC` 666, `CBC` 404, `FRO` 319, `CCC` 303, `CAC` 264,
`CRC` 174, `CFC` 160, `CPC` 122.

Status distribution is heavily skewed: primary `C` = 5,197 of 5,211. Secondary is blank
for 2,672 (essentially all the `QB` rows), `A` = 2,192, `I` = 347.

The 319 non-`QB` rows missing an expiration date correspond exactly to the 319 `FRO`
records — that licence type carries no expiry in this extract.

Expiration years cluster at 2028 (1,978) and 2026 (331), with a long tail of 45 already-expired
rows going back to 2019.

### Fields requested by the brief

All six required fields are present and usable:

| Requested                | Field                | Caveat                        |
| ------------------------ | -------------------- | ----------------------------- |
| License number           | 20 (or 1 + 12)       | Absent for all `QB` rows      |
| Primary status           | 13                   | 100% populated                |
| Secondary status         | 14                   | Blank for `QB` rows           |
| Expiration date          | 17                   | Absent for `QB` and `FRO`     |
| County                   | 11                   | Numeric code; `69` = Seminole |
| Business/individual name | 3, falling back to 2 | See the `QB` problem above    |

### Effort estimate — 0.5 to 1 day

Low. Two HTTP requests, a standard CSV parse, a county-code filter, and a name
normalizer. The genuine work is not the fetch, it is the matching semantics: the `QB`
split, the missing-expiry cases, and normalizing `LAST, FIRST M` against free-text permit
contractor names. Budget most of the time there.

At 48.8 MB the whole file fits comfortably in a normal zip-based Lambda's memory, with
range-request resume available if needed.

---

## Source 2 — Sunbiz corporate registrations

| Property          | Finding                                                                |
| ----------------- | ---------------------------------------------------------------------- |
| Reachable         | Yes                                                                    |
| Credentials valid | Yes — `Public` / `PubAccess1845!` authenticated successfully           |
| Browser required  | No (SFTP)                                                              |
| Host              | `sftp.floridados.gov:22`, server `SSH-2.0-VShell_5_0_0_3938`           |
| Quarterly size    | 1,819,049,954 bytes (1.69 GiB) compressed → **17.20 GiB** uncompressed |
| Quarterly records | **12,808,196** (exact)                                                 |
| Daily delta size  | ~0.9–6.9 MB, mean 3.2 MB                                               |
| Daily retention   | 1,348 files, 2022-01-03 → 2026-08-31, plus year archives to 2011       |
| Format            | Fixed-width, 1,440 bytes per record                                    |
| Effort estimate   | **3–5 days**                                                           |

### Path correction

The paths in the brief are missing a segment. The SFTP root contains only `Public/`, so
the real locations are:

- Quarterly: `/Public/doc/quarterly/cor/cordata.zip`
- Daily deltas: `/Public/doc/cor/yyyymmddc.txt`

`/doc/quarterly/cor/cordata.zip` as given returns `FileNotFoundError`.

### What is actually there

`/Public/doc/quarterly/cor/`:

- `cordata.zip` — 1,819,049,954 bytes, 2026-07-10
- `corevent.zip` — 189,342,315 bytes, 2026-07-09

Per the brief I did **not** download the quarterly archive. Instead I read the ZIP
central directory from the tail of the file over SFTP and decompressed only the first
400 KB of one member. That was enough to establish size, member count, record count, and
layout at a cost of a few hundred KB of transfer.

`cordata.zip` holds 10 members, `cordata0.txt` through `cordata9.txt`, each ~1.72 GiB
uncompressed:

- Total compressed: 1,819,048,212 bytes (matches the file size)
- Total uncompressed: 18,469,418,632 bytes = **17.20 GiB**
- Records: 18,469,418,632 ÷ 1,442 = **12,808,196 exactly**

Daily deltas in `/Public/doc/cor/` are named `yyyymmddc.txt` as documented — 1,348 of them
from `20220103c.txt` to `20260831c.txt`, published overnight around 02:30–03:20 UTC.
Retention is deeper than the flat listing suggests: subdirectories `2011` through `2021`
plus a `Prior to 2011` folder are also present, so history goes back roughly 15 years.

There is also an `Events` and a `Filings` subdirectory, and `corevent.zip` for event data,
none of which I explored — out of scope for a feasibility check.

### Line terminators differ between quarterly and daily — this will silently corrupt data

This is the single most dangerous detail in this source.

| Feed                       | Terminator | Bytes per record |
| -------------------------- | ---------- | ---------------- |
| Quarterly (`cordata*.txt`) | **CRLF**   | **1,442**        |
| Daily (`yyyymmddc.txt`)    | **LF**     | **1,441**        |

Both were verified arithmetically against exact file sizes:

- Daily: 2,843 records × 1,441 = 4,096,763 bytes — matches exactly.
- Quarterly member: 1,280,693 × 1,442 = 1,846,759,306 bytes — matches exactly.

The payload is 1,440 bytes in both cases. Parse by fixed 1,440-byte payload and strip the
terminator explicitly rather than assuming a stride, or every field after the first record
shifts by one byte per line and produces plausible-looking garbage.

Records are space-padded, latin-1, and each daily record is followed by four `\x00` bytes
at the end of the 1,440-byte payload.

### Record layout — derived, not documented

**No layout document ships with the feed.** I checked: `/Public/doc/notes/corindex.txt`
sounds promising but is a stale 2012 directory listing, and both `README.TXT` files only
point at a long-dead FTP server (`ftp://ftp.dos.state.fl.us/pub/doc/`). The offsets below
were derived empirically by column-occupancy analysis over 2,843 real records and then
validated by extracting and eyeballing the fields.

Offsets are 0-based, `[start:end)`:

| Field                          | Offset    | Len     | Example                                                                     |
| ------------------------------ | --------- | ------- | --------------------------------------------------------------------------- |
| Document number                | 0:12      | 12      | `L26000451950`                                                              |
| Corporation name               | 12:204    | 192     | `APEX ELITE CLEANING SERVICES  LLC`                                         |
| Status                         | 204:205   | 1       | `A` active, `I` inactive                                                    |
| Filing type                    | 205:210   | 5       | `FLAL`, `DOMP`, `DOMNP`, `FORL`, `FORP`, `DOMLP`, `FORLP`, `FORNP`, `TRUST` |
| — reserved (always blank)      | 210:220   | 10      |                                                                             |
| Principal address 1            | 220:262   | 42      | `7901 4TH ST N STE 300`                                                     |
| Principal address 2            | 262:304   | 42      | `STE 300`                                                                   |
| Principal city                 | 304:332   | 28      | `ST. PETERSBURG`                                                            |
| Principal state                | 332:334   | 2       | **Always blank in the daily feed**                                          |
| Principal ZIP                  | 334:344   | 10      | `33702`                                                                     |
| Mailing address 1              | 346:388   | 42      |                                                                             |
| Mailing address 2              | 388:430   | 42      |                                                                             |
| Mailing city                   | 430:458   | 28      | `MIAMI`                                                                     |
| Mailing state                  | 458:460   | 2       | `FL` (41 distinct)                                                          |
| Mailing ZIP                    | 460:470   | 10      | `33131`                                                                     |
| Mailing country                | 470:472   | 2       | `US`, `UN`, blank — dirty, includes `Us` and `FL`                           |
| File date                      | 472:480   | 8       | `08272026` = `MMDDYYYY`                                                     |
| FEI/EIN number                 | 480:494   | 14      | Populated for only 95 of 2,843 rows                                         |
| More-than-six-officers flag    | 494:495   | 1       | `N` or blank                                                                |
| State/country of incorporation | 503:505   | 2       | `FL` 2,700, `DE` 53, `WY` 9                                                 |
| Registered agent name          | 544:586   | 42      | `NORTHWEST REGISTERED AGENT LLC`                                            |
| Registered agent type          | 586:587   | 1       | `P` person 2,071, `C` company 772                                           |
| Registered agent address 1     | 587:629   | 42      |                                                                             |
| Registered agent city          | 629:657   | 28      |                                                                             |
| Registered agent state         | 657:659   | 2       | `FL`                                                                        |
| Registered agent ZIP           | 659:669   | 10      |                                                                             |
| Officer block × 6              | 668:1436  | 6 × 128 | see below                                                                   |
| Trailing NULs                  | 1436:1440 | 4       | `\x00\x00\x00\x00`                                                          |

The officer region is a clean repeating array: **6 slots of 128 bytes starting at offset
668**, which lands exactly on 1,436 and leaves the 4 NUL bytes. Within each 128-byte slot:
a 4-char title code (`AMBR`, `MGR`, `D`, `P`, `S`…), a 1-char person/company type, ~41
bytes of name, 42 bytes of address, 28 of city, 2 of state, 10 of ZIP.

Fields I did **not** fully resolve, and which would need work before trusting them:

- The internal split of personal-name fields into last / first / middle / suffix. Values
  like `FOSS                ORLANDO       WIV` suggest 20-char last name then a
  first/middle/suffix packing, but I did not confirm the boundaries.
- Offsets 495:503 and 505:544 are blank in almost all records; 495:503 held a date in 14
  of 2,843 rows, so something lives there but I could not identify it confidently.

### Quarterly vs daily content differ in kind

Beyond terminators, the two feeds are not interchangeable:

- **Status**: the daily deltas I sampled were 100% `A` (new filings). The quarterly sample
  was majority `I` (1,865 inactive vs 923 active). Only the quarterly gives you the
  inactive universe.
- **Case**: quarterly agent names are mixed-case (`Brandenberger  John  E`); daily names
  are uppercase. Any join needs case normalization.

### Seminole relevance is thin

Filtering the 2026-08-31 daily delta by Seminole ZIPs and municipality names: **51 of
2,843 records, 1.79%**. Projected onto the quarterly snapshot that is roughly **230,000
Seminole-scoped records** out of 12.8 million.

So you would ingest and scan 17.2 GiB to keep about 1.8% of it. There is no server-side
filter available — the archive is a single 10-member ZIP that must be streamed in full to
apply a county filter.

### Effort estimate — 3 to 5 days, and I recommend cutting it

The brief flags this source as low value and a candidate for cutting. The measurements
support that. Cost drivers:

1. **17.2 GiB of streaming decompression** across 10 members to retain ~1.8%. This does
   not fit a plain Lambda; it needs a streaming decompress with bounded memory, or Glue,
   or Fargate. That alone is a new execution shape for one low-value source.
2. **A hand-derived fixed-width layout with no authoritative reference.** Two named fields
   remain unresolved, and the personal-name sub-splitting is unconfirmed. Fixed-width
   parsing fails silently — a wrong offset yields plausible garbage, not an error. This
   needs its own validation harness.
3. **The 1,441 vs 1,442 terminator trap** between the two feeds, which must be handled
   explicitly and tested against both.
4. **A quarterly-plus-daily reconciliation model**: bootstrap from the snapshot, then
   replay daily deltas, with idempotent upserts keyed on document number and a
   backfill path across 1,348 retained files.

That is real batch-pipeline work — streaming decompression, a bespoke parser with a
validation suite, and delta reconciliation — for a source that the brief says appears in
no demo scenario and whose Seminole slice is 1.8% of the payload.

**Recommendation: cut it.** Reachability, credentials, size, and format are now all
proven and written down here, so the decision can be revisited cheaply and the work can
start from this document rather than from scratch. If some future scenario needs business
entities, the cheapest re-entry point is the daily deltas alone (~3.2 MB/day, trivial to
ingest) while skipping the 17.2 GiB historical snapshot entirely — that would cut the
effort to roughly a day, at the cost of having no pre-2022 history and no inactive entities.

---

## Summary

|                  | DBPR licenses             | Sunbiz corporations               |
| ---------------- | ------------------------- | --------------------------------- |
| Reachable        | Yes                       | Yes                               |
| Browser required | **No**                    | No                                |
| Transport        | HTTPS, 2 requests         | SFTP, password auth               |
| Payload          | 48.8 MB                   | 1.69 GiB → 17.2 GiB               |
| Records          | 271,941 (5,211 Seminole)  | 12,808,196 (~230k Seminole)       |
| Format           | CSV, 22 fields, no header | Fixed-width, 1,440-byte records   |
| Cadence          | Daily                     | Quarterly snapshot + daily deltas |
| Effort           | 0.5–1 day                 | 3–5 days                          |
| Recommendation   | **Build**                 | **Cut**                           |

The load-bearing outcome: **DBPR needs no browser, so the Chromium + Playwright
container-image tier has no remaining consumer and can be deleted.**

### Request volume used

Approximately 35 HTTP requests to `www2.myfloridalicense.com` (one full 48.8 MB download,
the rest sub-kilobyte range probes) and 8 SFTP sessions. One deliberate 150-second backoff
was required after triggering Cloudflare's rate escalation, described above.
