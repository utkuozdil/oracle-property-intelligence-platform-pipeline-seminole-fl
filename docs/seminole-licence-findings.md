# Florida DBPR contractor licences — findings

What the source actually is, what the join to permit contractors actually achieves, and the
places where measurement contradicted the plan. Everything here was measured against the live
extract fetched 2026-09-01, not inferred.

Code: `apps/api/src/licences/`. Infrastructure: `apps/api/cdk/lib/licence-stack.ts`.

---

## 1. The source

| | |
|---|---|
| URL | `https://www2.myfloridalicense.com/sto/file_download/extracts/CONSTRUCTIONLICENSE_1.csv` |
| Size | 48,780,751 bytes |
| Rows | 271,941, **no header** |
| Fields | 22, comma-delimited, every field quoted |
| Encoding | latin-1 (not UTF-8 — it will mis-decode) |
| `Last-Modified` | `Tue, 01 Sep 2026 10:48:27 GMT`, ~6h before fetch |

### The cookie replay still works — no browser needed

Confirmed rather than assumed, because the brief warned that two "it is bot-protected"
assumptions in this project turned out false and one turned out true.

A naive request returns **HTTP 403** with a Cloudflare interstitial. Visiting the landing page
first yields a `__cf_bm` cookie, and replaying it on the CSV request returns **HTTP 206** and
the full body over plain HTTP. Two requests, no Chromium, no headless tier.

This is implemented as `primeCookie()` then `downloadOnce()` in `http.ts`.

**Download time is wildly variable**: observed between 14.1s and 259.6s for the same 48.8 MB.
The Lambda timeout is set to the full 15 minutes and `MAX_FETCH_ATTEMPTS` to 2 because of this
— a tight timeout would fail intermittently for reasons that have nothing to do with
correctness.

### Contradicts the brief: this is a daily file, not a monthly one

The brief states "DBPR republishes monthly". It does not. `Last-Modified` was six hours old at
fetch time, and prior research in `seminole-contractor-business-sources.md` recorded the same
daily cadence. This does not change much — licence standing moves slowly — but it does mean the
schedule is a product choice rather than something dictated by the source.

### Contradicts the brief: the status vocabulary is narrower than documented

The brief lists primary statuses `C`/`P`/`S`/`N`/`D` = Current / Probation / Suspended /
Null-and-void / Delinquent. **Only three of the five occur in the file:**

| Primary status | Count | |
|---|---:|---|
| `C` | 35,753 | Current |
| `P` | 46 | Probation |
| `S` | 33 | Suspended |
| `N`, `D` | **0** | Do not appear at all |

There is therefore **no delinquent status code**, and "delinquent" — which the brief calls out
as a lead signal — has to be *derived*: primary `C` with an expiration date in the past. That
derivation is `deriveStanding()` in `parse.ts` and it is where the `expired` standing comes
from.

Secondary status is `A` (14,979) or `I` (2,086), and **blank for 18,767 rows** — every `QB` and
`FRO` row. "Usable = `C`+`A`" is right for the rows that have a secondary status and silently
excludes more than half the file otherwise.

### `QB` rows are the trap in this dataset

17,222 of the 35,832 retained rows are `QB` — *qualified business* registrations, not licences.
They have **no licence number, no expiry, and no secondary status**, and they carry the business
name in the *licensee* column (field 2) where every other row carries a person.

Consequences, each of which produced a bug before it was handled:

- A licence number cannot be the primary key of this dataset; 48% of rows have none.
- A `QB` row always derives to `current_unspecified`, which is an *absence* of information but
  outranks `expired` in a naive sort — so it can silently become the reported standing for a
  business whose real licence has lapsed.
- Business names only exist in field 3 for 49.6% of rows; for `QB` rows they are in field 2.
  Reading only field 3 loses half the names in the file.

---

## 2. Licence counts and standing

Retained population: **35,832 licences** across the six Orlando-metro counties (see §3), of
which 18,610 are numbered licences and 17,222 are `QB` registrations.

| Standing | Count | Meaning |
|---|---:|---|
| `current_unspecified` | 18,382 | Mostly `QB`/`FRO` rows: no secondary status to judge |
| `active` | 13,155 | `C` + `A`, unexpired |
| `expired` | 2,658 | `C` with a past expiry — the derived "delinquent" |
| `inactive` | 1,550 | `C` + `I` |
| `probation` | 46 | |
| `suspended` | 33 | |
| `expiring_soon` | 8 | |

**Adverse licences: 2,737.**

### The single most important caveat: 86% of "expired" is a calendar artefact

Florida construction licences run on a **biennial cycle ending 31 August of even years**. They
all expire at once, and DBPR takes weeks to process the renewals.

| | |
|---|---:|
| Expired on exactly `2026-08-31` | **2,287** |
| Expired before that | 371 |

The extract was fetched on **2026-09-01 — the day after the deadline**. So 86% of the expired
population is "has not renewed yet", not "is in trouble", and most of it will flip back to
current over the following weeks.

This matters because the brief's premise is that an expired licence on an open roofing permit is
a high-intent lead. For roughly two months every other year, that signal is mostly noise. The
run summary therefore carries `expiredBreakdown: { atRenewalDeadline, longLapsed }` so the
number can never be read without the split, and **371 long-lapsed is the figure to trust today**.

---

## 3. Join scope: Orlando metro, not Seminole, and deliberately not statewide

A contractor who pulls a Seminole permit need not hold a Seminole-registered licence. DBPR
records the licensee's own address, often a home address in a neighbouring county.

Measured against the same 2,367-name permit census:

| Scope | Licences | Matched | Rate |
|---|---:|---:|---:|
| Seminole only (code `69`) | 5,211 | 552 | 23.3% |
| **Orlando metro (6 counties)** | **35,832** | **1,495** | **63.2%** |
| Statewide | 271,941 | 1,970 | 83.2% |

Statewide looks best and is wrong. Compared against the metro scope it **changes the answer for
157 contractors that were already matched** — 10.5% of the overlap — and the changes are
regressions to identically named strangers:

| Permit name | Metro answer | Statewide answer |
|---|---|---|
| `SHEEGOG CONTRACTING` (254 permits) | Winter Park, **in Seminole** | Miami |
| `LANDMARK CONSTRUCTION CORP` | Sanford | Naples |
| `BMCI CONTRACTING INC` | Orlando | Lebanon, **out of state** |
| `THE ROOFING COMPANY LLC` | Melbourne | Jacksonville |

Recall bought by overwriting correct local answers with distant homonyms is not recall. The
scope stops at the metro: Seminole `69`, Orange `58`, Osceola `59`, Lake `45`, Volusia `74`,
Brevard `15` (codes verified against city distributions, since DBPR publishes no code table).

An explicitly stated licence serial is still allowed to reach outside the metro, because a
serial is not made wrong by the licensee's address — `NOLANDS ROOFING (CCC-1335461)` is
registered in Lake County and is matched on its number.

---

## 4. The join

**Hand-verified match rate: 1,402 of 2,249 distinct permit contractors — 62.3%.**
Of those, 108 (4.8%) are *keyed* matches resting on something the permit states outright rather
than on name similarity.

For calibration, BBB's deployed run matched 69.6%. This is lower, and the difference is mostly
the confidence floor: this tier makes a claim about a *named individual's professional licence*,
so it refuses more.

### Precision, measured rather than assumed

Two random samples were drawn from the matcher's own output and each row checked against the raw
CSV by licence number.

- **Sample 1 (40 rows)** found 38 strictly correct, 1 false positive, 1 reporting the wrong
  licence of the right business. Both defects were fixed.
- **Sample 2 (30 rows, independent seed, after the fixes)** found **29 of 30 correct** — the one
  failure being `VENTURE CONSTRUCTION GROUP` matched to a Balfour Beatty entity whose legal name
  ends "…, A JOINT VENTURE", also since fixed.

Quoting sample 2 as the estimate: **≈97% precision at 62.3% coverage.**

### The cascade

Strongest evidence first; it stops at the first tier that resolves unambiguously.

| # | Tier | Basis | Count |
|---|---|---|---:|
| 1 | `licence_number` | A serial stated in the permit name | 2 |
| 2 | `qualifier_unique` | Qualifier surname + licence prefix, unique | 12 |
| 3 | `qualifier_corroborated` | Qualifier surname + business-name agreement | 56 |
| 4 | `individual_name` | `LAST, FIRST` matched to a licensee | 38 |
| 5 | `business_exact` | Normalized business names identical | 1,017 |
| 5 | `business_truncated_prefix` | 30-char permit name continues into the licence name | 86 |
| 5 | `business_strong` | ≥0.82 similarity on a shared *distinctive* token | 191 |
| — | unmatched | | 847 |

The licence-qualifier suffix the brief flagged — `(CCC)`, `(CCC-ANGIULLI)` — is indeed a hint
rather than noise, and tiers 1–3 exist to exploit it. It is worth being honest about the size of
the prize: it produces 70 matches, not hundreds, because most parentheticals carry only a
licence *prefix* with no surname or serial. Its real value is precision, not volume.

### What had to be got right

**The entity is the business, not the licensee.** This was the largest correction. Grouping name
matches by licensee was wrong in both directions:

- `ICONTRACTING LLC` is carried by **three unrelated licensees** (Rivera in Palm Bay, Neira in
  Orlando, Moreira in Winter Springs). Grouped by person, the permit landed on whichever the
  scan reached first.
- `PRO LEVEL ROOFING INC` matched Justin Solitro correctly and then reported his `WEIRSTONE,
  LLC` licence, because that row had the best standing of everything the *person* held. A reader
  searching DBPR for the reported number would not find the company named on the permit.

**The 0.6 confidence floor was indefensible and is now 0.82.** Hand-checking the 0.6–0.82 band
found roughly half of its 361 matches wrong — not marginal calls but confident nonsense: `ONE
SOURCE ROOFING` → `SUNSHINE PROPERTIES SOURCE LLC`, `THE HOME DEPOT AT HOME SVCS` → `ASSURE-U AT
HOME SERVICES`. One of them, `SOUTHERN PRO RESTORATION LLC` → `SOUTHERN RESTORATION SERVICES`,
reported an *expired* licence against a company that is not the licensee. The band is not
salvageable by tuning, because its failures score as highly as its successes. Dropping it cost
~350 matches and the reported rate fell accordingly, which is the correct trade.

**BBB's distinctive-token lesson replicated exactly**, including a new instance of it: `EXTERIOR`
was treated as distinctive only because the generic list happened to hold the plural
`EXTERIORS`, which let `THE EXTERIOR COMPANY INC` claim `EXTERIOR HOMESAVERS INC` over thirteen
other candidates.

**Fuzzy matching is disabled for person-shaped permit names.** When the individual tier declines,
similarity against business names has nothing identifying left, and it scored `ORIE, THOMAS A`
against `PARRISH, THOMAS A` at 0.65 on the given name alone.

**A unique surname is dropped when the business name contradicts it.** A parenthetical is not
guaranteed to hold a surname: `AAGAARD-JUERGENSEN (ROBERT) LL` carries a *given* name, and
because exactly one metro licensee is surnamed Robert, the uniqueness rule confidently returned
their unrelated company `WOOD CRAFT`.

**Token blocking is what makes any scope beyond one county possible.** Unblocked, 2,367 names
against 230,000 entities is >500M similarity computations and does not finish. The blocking keys
are chosen to be equivalence-preserving — a missed block is a silently missed match — so there
is a key for each of the four ways `similarity` can clear the floor.

---

## 5. The adverse signal is trade-scoped, and that changed the answer

The product claim is "this contractor cannot currently roof lawfully". Two corrections were
needed before the output supported it.

**Rolling up every trade produced a false lead against the largest roofer in the census.**
`COLLIS ROOFING, INC.` — 760 Seminole permits — read `expired` on the strength of a lapsed `CFC`
**plumbing** licence held by a third qualifier, while its roofing `CCC` and general `CGC` both
run to 2028. The roll-up is now restricted to roofing-capable classes, and `QB` rows are
excluded from it entirely.

**The lead count is taken from the headline licence, not the worst one.** Counting the worst
conflates "cannot roof" with "something attached to this business has lapsed" — `SKY LIGHT
ROOFING INC` holds a current roofing `CCC` to 2028 and a lapsed general `CGC`, and appeared as a
lead purely on the latter.

Both fixes together: **106 → 72 contractors flagged**, and every remaining one is a contractor
whose own best roofing-capable credential is adverse.

| Lead standing | Count |
|---|---:|
| `expired` | 67 |
| `probation` | 4 |
| `suspended` | 1 |

Read with §2: most of those 67 expired on 2026-08-31 and will renew. `worstStanding` remains on
every row for anyone who wants the broader signal.

---

## 6. Schedule: weekly, Wednesday 12:00 UTC

- **Not daily.** An individual's licence standing moves on the order of months. Thirty runs a
  month would each pay a 48.8 MB download to report yesterday's answer, at a host that throttles.
- **Not monthly.** The lead is perishable; up to 30 days of staleness would mean showing a clean
  licence for a contractor suspended three weeks ago.
- **Wednesday**, because the permit harvest runs Sunday 09:00 — by Wednesday its census has
  landed and the join reads a fresh contractor list.
- **12:00 UTC**, because the source is regenerated late morning UTC (10:48 observed). An earlier
  slot would reliably fetch the previous day's file. Noon also clears every other timer in this
  pipeline: nightly roll 06:00, BBB monthly 07:00, permits Sunday 09:00.

`enabled: props.scheduleEnabled ?? true`, so it runs in dev as well.

---

## 7. Output layout

Mirrors BBB's, with `current.json` written **last** so it never points at a partial run.

```
staged/licences/seminole/run=<runId>/licences.ndjson
staged/licences/contractor-licences/run=<runId>/matches.ndjson
staged/licences/adverse/run=<runId>/adverse.ndjson
staged/licences/contractor-licences/current.json      <- pointer, written last
manifests/licences/<runId>/summary.json
manifests/licences/<runId>/unmatched.json
manifests/licences/ledger/<xx>/<sha256>.json          <- URL-keyed idempotency
```

Every record carries `fetchedAt` and `sourceUrl`.

The ledger is keyed by source URL with a 3-day freshness window. It stores the *derived* records
rather than the 48.8 MB body, so a retry or a same-day re-run costs no download and no request to
a host that escalates. `LEDGER_SCHEMA_VERSION` invalidates every entry when the record shape
changes, rather than letting a re-run deserialize an old shape into a new type.

Unmatched contractors are written out with their best candidate and score attached, which is what
makes the reported rate a measurement rather than an assertion.
