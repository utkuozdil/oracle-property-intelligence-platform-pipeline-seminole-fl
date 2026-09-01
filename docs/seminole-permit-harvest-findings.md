# Seminole County FL — Permit Harvest Feasibility Findings

**Question:** can Seminole County's permit portals be harvested with plain HTTP (cheap Lambda),
or do they require real browser automation (expensive container-image Lambda)?

**Answer: plain HTTP, for both sources. No browser automation is required anywhere.**

Both portals were driven end to end with `python-requests` — no JavaScript engine, no headless
Chrome, no Playwright. Every claim below is backed by a live response captured on
**2026-09-01, 08:16–09:45 Eastern**. Roughly 140 requests were made to Source A and 50 to
Source B in total.

This means the permit-harvest workers can be **zip-package Lambdas with a plain HTTP client**.
Nothing in either portal needs a browser runtime, so the container-image path and its cost,
cold-start, and image-management overhead can be dropped from the design.

---

## Table of contents

- [Verdict summary](#verdict-summary)
- [Source A — Building Public Request Portal](#source-a--building-public-request-portal)
  - [Why the previous attempt failed](#why-the-previous-attempt-failed)
  - [Exact working request shape](#exact-working-request-shape)
  - [Response state machine](#response-state-machine)
  - [Pagination mechanics](#pagination-mechanics)
  - [Viewstate reuse](#viewstate-reuse-halves-the-request-count)
  - [Volume, horizon, and sweep estimate](#volume-horizon-and-sweep-estimate)
- [Source B — Click2Gov](#source-b--click2gov)
  - [Exact working request shape](#exact-working-request-shape-1)
  - [The silent 50-row cap](#the-silent-50-row-cap)
  - [Open duration](#open-duration-the-core-crm-signal)
  - [Sweep estimate](#sweep-estimate)
- [WAF and rate-limit behaviour](#waf-and-rate-limit-behaviour)
- [Recommended concurrency](#recommended-concurrency)
- [Implementation cautions](#implementation-cautions)
- [Open questions](#open-questions)

---

## Verdict summary

|                  | Source A (bulk census)                | Source B (status)                           |
| ---------------- | ------------------------------------- | ------------------------------------------- |
| Transport        | **Plain HTTP**                        | **Plain HTTP**                              |
| Browser required | No                                    | No                                          |
| Keyed by         | permit type × calendar month          | application number, parcel, address, name   |
| Session needed   | Yes (`ASP.NET_SessionId` + viewstate) | **No** for status detail; yes for sub-views |
| Page size / cap  | 50/page, full pagination              | **hard 50-row cap, silent, no pagination**  |
| Median latency   | **0.62–0.82 s**                       | **2.3 s** (status detail)                   |
| Full sweep       | ~13,200 requests, **~3 h sequential** | scope-dependent, see below                  |
| Blocking seen    | none                                  | none                                        |

---

## Source A — Building Public Request Portal

`https://scwebapp2.seminolecountyfl.gov:6443/BuildingPublicrequestportal/`

ASP.NET WebForms 4.0.30319 + Telerik RadGrid 2014.1.326.35 on IIS 10.0.

**Settling evidence.** A single `POST` with a correctly-built form body returns a fully
populated grid. For `REROOF RESIDENTIAL` over August 2026 the response was
`176 items in 4 pages`, and paging through all four yielded 50 + 50 + 50 + 26 = **176 rows**,
matching the server's own count exactly. Real data came back — actual application numbers,
parcel ids, addresses, owners, contractors and valuations:

```
AppNo    26-12426
ParcelID 15-21-30-509-0000-0380
Address  103 GULL CT, CASSELBERRY FL 327070000
Subdiv   DEER RUN UNIT 06
Issued   08/31/26
Owner    NEUMANN, WILLIAM J & MARICONDA
Contractor ERIE CONSTRUCTION MID-WEST(CCC
Valuation  33,729
```

Because the portal queries by **permit type × date range** and not by parcel, this replaces
71,861 per-parcel requests with a few hundred month-window searches. That inversion is
confirmed working.

### Why the previous attempt failed

The earlier diagnosis — that the Telerik `_ClientState` JSON fields were not populated — was
**not** the cause. Two other things were, and the first is the real one:

1. **The dropdown posts a code, not a label.** The `<option>` values are short codes:
   `REROOF RESIDENTIAL` is `R100`, `REROOF COMMERCIAL` is `C110`, `ALL TYPES` is `ALL`.
   Posting the display string `REROOF RESIDENTIAL` is not a valid option value, so ASP.NET
   discards it and the control falls back to its default (`ALL`, which is the pre-selected
   option). That exactly reproduces the reported symptom of "the permit type reverted to its
   default".

2. **The date range must be inside one calendar month.** A server-side validator rejects
   anything wider, emitting `The dates must be in the same month.` in
   `ctl00_ContentPlaceHolder7_BuildingPublicRequestPortal1_dateCompareValidator`. When it
   fires, the grid is **not rendered at all** and the response falls back to roughly the size
   of the initial page (~74 KB). This is almost certainly what produced the "No records to
   display" reading on a wide range.

On the `_ClientState` question specifically: **the initial GET ships all of these fields
empty**, and posting them empty works fine. The picker's real value is read from the visible
`...$StartDatePicker` (ISO `yyyy-MM-dd`) and `...$StartDatePicker$dateInput` (`M/d/yyyy`)
inputs. Populating `_ClientState` in its documented shape also works and is what the reference
implementation below does — it is belt-and-braces, not a requirement. The collapsible panel's
`_ClientState` likewise does not need to say "expanded"; it ships empty and the controls are
honoured regardless.

### Exact working request shape

One `GET` to establish `ASP.NET_SessionId` and harvest the hidden fields, then `POST` back to
the same URL as `application/x-www-form-urlencoded`.

**Headers** — a realistic browser `User-Agent` is mandatory; a default `curl` UA is filtered.

```
User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36
Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8
Accept-Language: en-US,en;q=0.9
Content-Type: application/x-www-form-urlencoded
Referer: https://scwebapp2.seminolecountyfl.gov:6443/BuildingPublicrequestportal/
Origin: https://scwebapp2.seminolecountyfl.gov:6443
```

**Cookies** — persist `ASP.NET_SessionId` across the GET and all POSTs.

**Body** — round-trip _every_ hidden input exactly as the server shipped it
(`__VIEWSTATE` ≈ 13 KB, `__VIEWSTATEGENERATOR` = `7191D65C`, `__EVENTVALIDATION` ≈ 2.5 KB,
`__SCROLLPOSITIONX/Y`, `ctl00_ToolkitScriptManager1_HiddenField`, `ctl00$ToolkitScriptManager1`),
then override:

```
__EVENTTARGET                = (empty)
__EVENTARGUMENT              = (empty)
ctl00$ContentPlaceHolder7$BuildingPublicRequestPortal1$TypeDropDownList   = R100
ctl00$ContentPlaceHolder7$BuildingPublicRequestPortal1$StartDatePicker             = 2026-08-01
ctl00$ContentPlaceHolder7$BuildingPublicRequestPortal1$StartDatePicker$dateInput   = 8/1/2026
ctl00$ContentPlaceHolder7$BuildingPublicRequestPortal1$EndDatePicker               = 2026-08-31
ctl00$ContentPlaceHolder7$BuildingPublicRequestPortal1$EndDatePicker$dateInput     = 8/31/2026
ctl00$ContentPlaceHolder7$BuildingPublicRequestPortal1$SubmitRequestButton         = \u00a0Submit\u00a0
```

Note the submit button value is `Submit` wrapped in non-breaking spaces (`\u00a0`), and that
`SelectImageButton` must **not** be sent (it is `type=image`; only the clicked button posts).

Telerik hidden fields, mirroring what the page ships. Note these use **underscores**, not
`$`, and that `_ClientState` may be left empty:

```
ctl00_..._StartDatePicker_dateInput_ClientState = {"enabled":true,"emptyMessage":"","validationText":"2026-08-01-00-00-00","valueAsString":"2026-08-01-00-00-00","minDateStr":"1980-01-01-00-00-00","maxDateStr":"2099-12-30-00-00-00","lastSetTextBoxValue":"8/1/2026"}
ctl00_..._StartDatePicker_calendar_SD           = [[2026,8,1]]
ctl00_..._StartDatePicker_calendar_AD           = [[1980,1,1],[2099,12,30],[2026,8,1]]
ctl00_..._StartDatePicker_ClientState           = (empty)
```

…and the same four for `EndDatePicker`. The Telerik canonical datetime format is
`yyyy-MM-dd-HH-mm-ss`; the min/max bounds `1980-01-01` and `2099-12-30` come from the page.

**Verification that binding took effect:** the response echoes the selection back. Assert that
the `<option selected>` in `TypeDropDownList` is the code you sent and that
`...$StartDatePicker` echoes your date. Both were confirmed correct on every successful query.

### Response state machine

Four distinct outcomes, and they must be told apart — two of them look superficially like
"no data" but mean very different things. Classify on the grid table
`ctl00_..._PermitListingForTypeRadGrid_ctl00`:

| State         | Signature                                                           | Meaning                                                                               |
| ------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `REJECTED`    | grid table **absent**, `dateCompareValidator` has text, body ~74 KB | query invalid (e.g. range crosses months). **Fix and retry — do not record as zero.** |
| `EMPTY`       | grid present, contains `tr.rgNoRecords` ("No records to display.")  | genuinely zero records                                                                |
| `SINGLE_PAGE` | rows present, `.rgInfoPart` **absent**                              | total = row count, one page only                                                      |
| `PAGED`       | rows present, `.rgInfoPart` present                                 | `"N items in M pages"`                                                                |

Verified on all five cases:

```
R100 2026-08-01..2026-08-31  -> PAGED        rows=50 total=176 pages=4   229584b
C110 2026-08-01..2026-08-31  -> SINGLE_PAGE  rows=13 total=13            175886b
EZRO 2026-08-01..2026-08-31  -> EMPTY        rows=0  total=0             159918b
R100 2026-07-01..2026-08-31  -> REJECTED     "The dates must be in the same month."  74697b
R100 2026-08-31..2026-08-01  -> EMPTY        rows=0  total=0             159996b
```

Treating `REJECTED` as zero is the single most dangerous failure mode here: it silently drops
whole months. Note also that reversed dates (`end < start`) return `EMPTY` rather than an
error, so range construction should be asserted client-side.

**`.rgInfoPart` is absent whenever the result fits on one page.** Deriving the total only from
`"N items in M pages"` will read 13 real rows as zero. Always fall back to counting
`tr.rgRow`/`tr.rgAltRow`.

### Pagination mechanics

Standard ASP.NET postback. Page size is 50 (selectable 10/20/50).

The reliable technique is to **scrape the pager button out of the current response** rather
than construct it: take the `<input type="submit">` whose class is `rgPageNext`, and post its
`name` back with any value, alongside a full round-trip of that response's hidden fields.

Do **not** hardcode the control index. The numeric page links are
`...$PermitListingForTypeRadGrid$ctl00$ctl03$ctl01$ctlNN` where `NN` = 03 + 2×page, and
"Next" was `ctl14` on a 4-page result but `ctl28` on a 35-page result — the index shifts with
the number of numeric links rendered.

Page-boundary integrity was verified: 4 pages returned exactly 176 rows for a stated total of
176, with no gaps.

### Viewstate reuse halves the request count

**One `GET` is enough for an entire sweep.** Each search response carries a fresh, valid
viewstate that can be used to build the _next_ search. Twelve consecutive monthly searches
were chained off a single initial GET with no re-GET, all succeeding:

```
single initial GET 0.98s
2025-01 PAGED total=203  1.06s      2025-07 PAGED total=148  0.64s
2025-02 PAGED total=236  0.86s      2025-08 PAGED total=164  0.65s
2025-03 PAGED total=249  0.81s      2025-09 PAGED total=150  0.63s
2025-04 PAGED total=334  0.67s      2025-10 PAGED total=154  0.82s
2025-05 PAGED total=228  0.64s      2025-11 PAGED total=105  1.55s
2025-06 PAGED total=264  0.70s      2025-12 PAGED total=151  0.80s
latency n=12 min=0.63 med=0.75 max=1.55 mean=0.82
```

So N searches cost 1 GET + N POSTs, not 2N requests.

### Volume, horizon, and sweep estimate

**Measured latency**, 45 consecutive requests at 0.4 s spacing: **median 0.62 s, mean 0.66 s,
max 1.51 s**. No degradation over the run.

**Data horizon: 1996.** March/July/November sampled for each year — 1993, 1994 and 1995 all
return `EMPTY`; 1996 is the first year with data. (An earlier probe appeared to show no data
before 2015; that was the same-month validator rejecting full-year ranges, not a real horizon.)

**Sampled `ALL TYPES` monthly volumes** (Mar/Jul/Nov, annual estimate = mean × 12):

| Year      | Sampled months   | Annual est.    |
| --------- | ---------------- | -------------- |
| 1993–1995 | 0, 0, 0          | 0 (no data)    |
| 1996      | 689, 765, 645    | 8,400          |
| 1998      | 1239, 1007, 830  | 12,300         |
| 2000      | 1055, 974, 907   | 11,700         |
| 2002      | 1265, 1152, 1273 | 14,800         |
| 2005      | 3770, 3693, 1871 | 37,300         |
| 2008      | 1861, 1980, 1029 | 19,500         |
| 2011      | 1405, 1437, 1026 | 15,500         |
| 2014      | 1542, 1627, 1219 | 17,600         |
| 2017      | 1972, 1776, 2176 | 23,700         |
| 2020      | 2515, 3054, 2078 | 30,600         |
| 2023      | 2509, 2146, 1860 | 26,100         |
| 2026      | 2320, 1884, —    | (partial year) |

Full-year 2025 measured exactly: **25,905 rows across 12 months → 519 page requests**.
The 2005 peak (~37k/yr) is the housing boom; the profile is not flat, so a flat-rate estimate
would understate the middle years.

**Full historical sweep, `ALL TYPES`, 1996–2026** (linear interpolation between sampled years):

```
estimated rows                 ~642,000
page requests @ 50/page          12,835
+ month-window searches             372   (31 years x 12)
+ initial GET                         1
TOTAL                           ~13,200 requests

sequential @ 0.75s/req            ~2.8 h
sequential @ 1.00s/req            ~3.7 h
4-way parallel @ 0.75s/req        ~0.7 h
```

**Roofing-only alternative.** `R100` was 2,386 rows in 2025, about 9.2 % of all types, so
roofing across the horizon is roughly 64,000 rows ≈ 1,285 page requests. But sweeping 9
roofing codes separately costs 9 × 12 × 31 = 3,348 searches, giving ~4,600 requests total.
That is only ~3× cheaper than sweeping `ALL TYPES`, which brings back the entire permit
dataset for every category.

**Recommendation: sweep `ALL TYPES` by month and filter client-side.** ~13,200 requests and
under 4 hours sequential is cheap enough that narrowing to roofing is a false economy, and it
future-proofs against roofing codes being added or renamed.

Either way this is comfortably a **cheap zip-package Lambda** workload. With a 15-minute
Lambda ceiling, shard by (year, month) — 372 shards, each a handful of seconds to a couple of
minutes — rather than attempting one long-running invocation.

---

## Source B — Click2Gov

`https://semc-egov.aspgov.com/Click2GovBP/selectpermit.html`

Click2Gov on a Java servlet container (`JSESSIONID`), behind F5 BIG-IP ASM
(`TS015cebb1`, `TS012aa550`, `TS7f527e98027` cookies present on every response).

**Confirmed: server-rendered HTML, plain HTTP, no browser needed.** All of Application Date,
Valuation, General Contractor, Tenant Name and Zoning Description are reachable, plus the
permit status, inspections, plan tracking and fees.

Source B is far more permissive than expected. Verified individually, **none** of the
following is required for a status-detail lookup:

| Removed                         | Result                       |
| ------------------------------- | ---------------------------- |
| all cookies (no session at all) | HTTP 200, full Status Detail |
| `OWASP_CSRFTOKEN`               | HTTP 200, full Status Detail |
| `Referer`                       | HTTP 200, full Status Detail |
| browser UA (used `curl/8.4.0`)  | HTTP 200, full Status Detail |

A **single stateless POST** returns the full detail page. Unlike Source A there is no
GET-then-POST handshake and no per-session token to manage, which makes Source B trivially
parallelisable and retryable. The `OWASP_CSRFTOKEN` is present in the HTML and is worth
sending for politeness and future-proofing, but it is not enforced today.

Session continuity **is** required for the tab sub-views: requesting the inspections view on a
fresh session with no prior permit selection returns the site home page with zero rows, so the
selected permit is held in server-side session state.

### Exact working request shape

Four search methods. Method 0 is the one to build on — it takes an application year and
number, which **joins directly to Source A's `AppNo`**, and it returns the detail page in one
request with no intermediate result list.

```
POST https://semc-egov.aspgov.com/Click2GovBP/selectpermit.html
Content-Type: application/x-www-form-urlencoded

validatePermitView = true
searchType         = 0
searchMethod       = 0
permit.appYear     = 26        # 2 digits
permit.appNumber   = 12426     # up to 8 digits, zero-padding optional
finish             = Continue
OWASP_CSRFTOKEN    = <scraped>  # optional
```

**The join.** Source A `AppNo` `26-12426` splits on `-` into `appYear=26`, `appNumber=12426`.
Result lists render it zero-padded as `26-00012426`. Verified round-trip:

| Source A                                        | Source B                                            |
| ----------------------------------------------- | --------------------------------------------------- |
| `AppNo 26-12426`                                | `Application Number 26 - 12426`                     |
| `ParcelID 15-21-30-509-0000-0380`               | `Parcel ID 15-21-30-509-0000-0380`                  |
| `PropertyAddress 103 GULL CT`                   | `Address 103 GULL CT`                               |
| `ContractorName ERIE CONSTRUCTION MID-WEST(CCC` | `General Contractor ERIE CONSTRUCTION MID-WEST(CCC` |
| —                                               | `Application ON HOLD` ← **only available here**     |
| —                                               | `Zoning Description PLANNED UNIT DEVELOPMENT`       |
| —                                               | `Application Date 08/26/26`                         |

The other three methods use `searchResultsView=true` and submit as `target1=Continue`:

- **`searchType=1`** address — `parcel.streetNumber`, `parcel.streetName`,
  `parcel.streetDirection`, `parcel.streetSuffix`, `streetSearchType` (`begins`|`contains`)
- **`searchType=2`** parcel — `parcel.parcelNumber1..6`, which map segment-wise onto Source A's
  `ParcelID`: `15-21-30-509-0000-0380` → Section `15`, Township `21`, Range `30`,
  Subdivision `509`, Block `0000`, Lot `0380`
- **`searchType=3`** name — `searchName`, `searchNameSearchType` (`C`=contains, `B`=begins)

`searchType=2` is genuinely useful: one request returns a parcel's **entire permit history
with status**, back to 1989 for the test parcel — 14 permits including `PERMIT COMPLETE`,
`VOIDED`, `CLOSED`, `PERMIT ISSUED` and `ON HOLD`.

**Sub-views** — `GET` on the same session after a selection:

| View          | Path                                       | Yields                                                                |
| ------------- | ------------------------------------------ | --------------------------------------------------------------------- |
| Status Detail | `permitinfo.html?statusDetailView=true`    | app date, owner, valuation, sq ft, tenant, contractor, zoning, status |
| Permit        | `permitinfo.html?permitStatusView=true`    | structure/sequence/permit, description, contractor                    |
| Plan Tracking | `permitinfo.html?planTrackStatusView=true` | agency, in / estimated completion / last dates                        |
| Inspections   | `selectinsp.html?projectInspView=true`     | inspection type, scheduled date, status, **result date**              |
| Fees          | `collectfees.html?viewAppFees=true`        | fee lines, amount charged, amount due                                 |

### The silent 50-row cap

**Searches 1, 2 and 3 truncate at exactly 50 rows, with no warning text and no pagination.**

```
addr begins   OAK   -> 50 rows   (11 distinct addresses)   no notice
addr contains OAK   -> 50 rows   ( 8 distinct addresses)   no notice
addr begins   MAIN  -> 50 rows   (16 distinct addresses)   no notice
name  begins  SMITH -> 50 rows   (35 distinct addresses)   no notice
addr 103 GULL CT    -> 14 rows   ( 1 address)              true count
```

Three unrelated broad searches all landing on exactly 50 while a narrow search returns 14
establishes 50 as a server cap rather than a coincidence. The results table is a client-side
DataTables widget (`data-paging="true"`) that paginates over **only the rows already in the
HTML**, so there is no "next page" to fetch — the missing rows are simply never sent.

Consequences:

- **Never use address or name search for enumeration.** It will silently return a truncated
  set that looks complete.
- Parcel search inherits the same cap. 14 rows for the test parcel is safely under it, but a
  large commercial or condo parcel could exceed 50 and be truncated invisibly. If parcel
  search is used, cross-check the returned count against the Source A census for that parcel
  and treat exactly 50 as "suspect, truncated".
- **`searchType=0` is the only cap-free path**, since it resolves to a single permit. This is
  the decisive reason to drive Source B from Source A's application numbers rather than by
  enumerating addresses or parcels.

### Open duration — the core CRM signal

There is **no explicit close or completion date field** anywhere on the detail page. Open
duration must be assembled from two places:

- **Start** — `Application Date` on Status Detail.
- **End, if still open** — `now()`. The `Application` status field carries the lifecycle state.
- **End, if closed** — the **`Result Date` of the terminal inspection** from the inspections
  sub-view.

Verified against a matched open/closed pair on the same parcel:

```
26-12426  Application Date 08/26/26   Application ON HOLD
          inspections: ROOF IN-PROGRESS RESIDENTIAL (no dates), FINAL ROOF (no dates)
          -> still open; duration = now - 2026-08-26

21-13064  Application Date 07/07/21   Application PERMIT COMPLETE
          inspections: ROOF IN-PROGRESS RESIDENTIAL  APPROVED  10/21/2021
                       FINAL ROOF                    APPROVED  10/25/2021
          -> closed 2021-10-25; open duration = 110 days
```

**Cost implication.** For permits that are currently open — the ones that matter for a CRM
signal — status and application date come from the **single** select POST, so it is 1 request
per permit. Only closed permits need the extra inspections GET to pin the close date, i.e. 2
requests. Scope accordingly: if the signal is "which roofs are open and for how long", the
inspections view is not needed on the hot path.

**Status vocabulary observed** (7 values, from sampled responses — this is an observed sample,
not a documented enumeration, so unknown values should alert rather than be silently bucketed):
`PERMIT COMPLETE`, `CLOSED`, `VOIDED`, `PERMIT ISSUED`, `IN APPROVAL`,
`CERTIFICATE OF COMPLETION`, `ON HOLD`. Canonical mapping is in `seminole-sources.yaml`.

### Sweep estimate

**Measured latency**, 15 consecutive select POSTs at ~1.0 s jittered spacing:
**min 2.25 s, median 2.28 s, max 2.43 s, mean 2.32 s** — notably steady, and about 3× slower
than Source A. At concurrency 3 it degraded modestly to 2.38–3.42 s.

| Scope                                         | Permits | Requests | Sequential | @ concurrency 3 |
| --------------------------------------------- | ------- | -------- | ---------- | --------------- |
| Roofing, last 24 months (status only)         | ~5,400  | ~5,400   | ~3.5 h     | **~1.2 h**      |
| Roofing, last 24 months (+ close dates)       | ~5,400  | ~10,800  | ~7 h       | ~2.3 h          |
| Roofing, full history 1996–2026 (status only) | ~64,000 | ~64,000  | ~41 h      | ~14 h           |
| Roofing, full history (+ close dates)         | ~64,000 | ~128,000 | ~82 h      | ~27 h           |

Source B is the expensive source, ~3× the per-request latency of Source A and one request per
_permit_ rather than per 50 rows. **Do not run it over all history on the first pass.** Status
is only decision-relevant for recent permits; historical permits are almost all terminal and
their status is largely inferable from the Source A census plus a one-off backfill. Recommended
shape: harvest Source A in full, then run Source B over a recent window (24 months covers the
open-permit population comfortably), then top up incrementally, refreshing only permits not yet
in a terminal state.

Still a **cheap zip-package Lambda** — but shard by application-number batch to stay well
inside the 15-minute ceiling (e.g. 200 permits ≈ 8 minutes sequential per invocation).

---

## WAF and rate-limit behaviour

**No blocking, throttling or challenge was observed on either host.**

Source A, ~140 requests including 45 consecutive at 0.4 s spacing and 24 chained searches:
every response HTTP 200, latency flat at 0.62 s median with no upward drift. No `429`, no
`503`, no challenge page, no CAPTCHA.

Source B, ~50 requests: 15 sequential at ~1.0 s jittered spacing all HTTP 200 with flat
2.3 s latency, then 9 requests at concurrency 3 across separate sessions, also all HTTP 200.
Responses were checked for F5 ASM block signatures (`The requested URL was rejected`,
`Support ID`, status 403/406/419/429/503) on every request — **none fired**.

The F5 BIG-IP ASM in front of Source B is real and is setting its `TS*` cookies, but it did not
interfere at the volumes probed. This is the expected posture: ASM blocks rather than degrades,
so absence of any block signature across ~50 requests is meaningful but is **not** evidence
about behaviour at 10× or 100× that rate. F5 blocks can be sticky by source IP, so a block
during a large sweep could take the whole worker IP out for an extended period.

Deliberately **not** probed: the point at which either host starts refusing. Finding the
throttle ceiling means getting blocked, and a sticky IP ban would jeopardise the actual
harvest. The concurrency guidance below is therefore conservative by design.

## Recommended concurrency

|          | Recommended     | Hard cap | Rationale                                                                                                                                                     |
| -------- | --------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source A | **2**           | 4        | Single county IIS box on a non-standard port with a daily maintenance window. Sequential is already fast enough (~3 h full sweep), so there is little to buy. |
| Source B | **2**, jittered | 3        | F5 ASM present. Concurrency 3 was clean but is the highest level with evidence behind it.                                                                     |

Additional operational guidance:

- **Respect the Source A outage: down daily 23:30–07:00 Eastern.** Schedule outside it and
  treat connection failures in that window as expected, not as errors.
- Add **jitter** (±30 %) to inter-request delays on both hosts rather than a fixed cadence.
- Implement a **circuit breaker**: on any 403/406/429/503 or F5 block signature, stop that
  worker immediately, do not retry in a tight loop, and back off for a long interval. A sticky
  IP block is much more costly than a slow sweep.
- Use **exponential backoff with a low retry ceiling** (3 attempts) and treat repeated
  failures as a signal to pause the whole sweep, not just the shard.
- Prefer a **single egress IP with modest, steady load** over rotating IPs — the latter is more
  likely to look anomalous to ASM.

## Implementation cautions

1. **`AppNo` is not a unique key on Source A.** One application can produce several grid rows
   for different structures or permit-type sequences. Over 4 pages of `REROOF RESIDENTIAL` for
   August 2026, 176 rows contained 175 distinct `AppNo` values. Under `ALL TYPES` the
   divergence is larger, since one application yields a row per permit type. Use the composite
   key `(AppNo, StructureSequence, PermitTypeSequence)`.

2. **Row order is not stable between identical queries.** The same `R100` August-2026 search
   run twice in fresh sessions returned the **same set** of 50 page-1 rows but in a
   **different order**. The grid has no explicit sort, so ties on `IssueDate` are ordered
   non-deterministically by the database. Row sets matched here, but an unstable sort means a
   page boundary falling inside a tie group can in principle duplicate or drop rows during
   deep pagination. Mitigate by deduplicating on the composite key across the whole month
   rather than trusting page disjointness, and by reconciling the collected count against the
   `"N items in M pages"` total.

3. **Distinguish `REJECTED` from `EMPTY`.** See the state machine above. A rejected query that
   is recorded as zero silently loses a whole month of permits.

4. **`.rgInfoPart` is absent for single-page results.** Always fall back to counting rows.

5. **Never hardcode pager control indices.** Scrape `rgPageNext` from the current response.

6. **The application-type vocabulary changes over time.** `EZRO` (`EZ REROOF RESIDENTIAL`)
   returned 0 rows for 2026-08 but 211 rows for 2022-10. `C202`/`R200` (hurricane reroof) are
   event-driven and empty in ordinary months. A historical sweep must iterate every roofing
   code across the whole period, not just the codes active today.

7. **`PermitType` is a second, distinct vocabulary.** The dropdown holds _application_ type
   codes (`R100`, `C110`); the grid's `PermitType` column holds internal permit codes
   (`RR REROOF`, `MEC2 MECHANICAL ALL OTHER`, `BPNA BLDG PMT NEW / ALTERATION R`,
   `BPRF BLDG PERMIT/ROOF`, …). Sixteen were observed and are recorded in the YAML. Do not
   conflate the two.

8. **Field hygiene.** `ContractorName` and `OwnerName` are truncated by the source at ~30
   characters (`ERIE CONSTRUCTION MID-WEST(CCC`), so they are unreliable as join keys.
   `ZipCode` carries a `+4` suffix of zeros (`327070000`). `ValuationAmount` is a
   comma-formatted string. `IssueDate` is `MM/DD/YY` and needs century inference — pivot on
   the horizon (1996) rather than a naive 2-digit window. Owner names may be
   `CONFIDENTIAL PER STATUTES` under Florida public-records exemptions.

9. **Source B is stateless for status detail but stateful for sub-views.** Do not assume a
   session carried from a select POST is still valid after retries or across workers; re-select
   the permit before reading a sub-view.

## Open questions

- **Parcel-search truncation.** No parcel exceeding 50 permits was located, so the cap was not
  observed firing on `searchType=2`. If parcel search is used in production, treat exactly 50
  rows as suspected truncation and reconcile against the Source A census.
- **Throttle ceilings.** Deliberately not probed on either host, for the reasons above. Ramp
  gradually in production and instrument for block signatures from the first request.
- **`https://scccap01.seminolecountyfl.gov/buildingpermitwebinquiry/`** is linked from
  Click2Gov and was not evaluated. It may be a lighter-weight or bulk-friendlier status source
  and is worth a look before committing to the Source B request budget.
- **Exact status enumeration.** Seven values were observed; the full set is undocumented.
  Unknown statuses should be quarantined and alerted rather than mapped by guess.
- **Incremental change detection.** Whether an already-harvested permit's Source A row can
  change after issuance (e.g. valuation revision) was not tested. Until confirmed, re-harvest
  the current and previous calendar month daily rather than treating closed months as immutable.
