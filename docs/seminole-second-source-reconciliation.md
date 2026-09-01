# Seminole County — Second Source Reconciliation (FDOR Cadastral Centroids 2025)

Status: research complete, measured against live data on 2026-09-01.
Scope: read-only validation. No pipeline, app, or package code was changed by this investigation.

Every number in this document comes from a query that was actually executed. The FDOR extract
was paged in full (179,107 of 179,107 rows, zero request failures) and joined against the
181,218-row CAMA Parquet. Nothing here is estimated.

---

## 1. The source

| Property                  | Value                                                                                                                          |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Service                   | `Florida_Statewide_Parcel_Centroid_Version`, layer 0                                                                           |
| Layer name (as published) | `FDOR Cadastral Centroids 2025`                                                                                                |
| Base URL                  | `https://services9.arcgis.com/Gh9awoU677aKree0/ArcGIS/rest/services/Florida_Statewide_Parcel_Centroid_Version/FeatureServer/0` |
| Seminole filter           | `CO_NO=69`                                                                                                                     |
| Format                    | Esri JSON (`f=json`), point geometry, requested as `outSR=4326`                                                                |
| Records for Seminole      | 179,107                                                                                                                        |
| Assessment year           | `ASMNT_YR = 2025` for 100% of rows (single value, no mixing)                                                                   |
| Fields available          | 120                                                                                                                            |
| `maxRecordCount`          | 2000, `supportsPagination: true`                                                                                               |
| Cost                      | Free, public, no key, no auth                                                                                                  |

Count verification, both run against the live service:

```
CO_NO=69  -> {"count":179107}     (Seminole)
CO_NO=46  -> {"count":556100}     (Lee, matches the known cross-check)
```

### County code correction — 69 is correct, 59 is Osceola

Independently corroborated two ways:

1. FDOR's own NAL tax-roll file listing on the PTO Data Portal names the county-59 file
   `Osceola 59 Preliminary NAL 2026.zip`. (Note for the record: FDOR's listing has a filename
   typo — the Seminole file is published as `Seminole 58 Preliminary NAL 2026.zip` even though
   58 is Orange. The numeric code in the filename is unreliable; the in-record `CO_NO` is not.)
2. Every `CO_NO=69` record carries `STATE_PAR_` prefixed `C69-`, and `OWN_CITY` values are
   Sanford, Casselberry, Oviedo, Chuluota, Altamonte Spg, Lake Mary, Heathrow — Seminole
   municipalities.

`CO_NO=69` is Seminole. Confirmed.

---

## 2. Independence — an honest assessment

This source is **partially independent, and the limit matters.**

**What is genuinely independent:**

- It is the FDOR-certified 2025 NAL tax roll, a separate statutory submission with its own
  schema, its own field semantics, and its own certification cycle. It is not a mirror of the
  nightly SCPA CAMA extract.
- It carries independent artifacts that prove a separate processing lineage: `OWN_NAME` is hard
  truncated at 30 characters (42,860 rows sit exactly at 30 chars) while CAMA's `owner_name`
  runs to 101 characters, with 50,287 rows longer than 30. The two strings cannot have come
  from the same serialization.
- It applies FDOR's own sale-qualification coding (`QUAL_CD1`), which CAMA does not expose, and
  which turns out to explain a disagreement class outright (see §5.3).
- It is a fixed August-2025 snapshot versus CAMA's nightly current state, so it is a real
  temporal control.

**What is not independent, and should not be sold as such:**

- The upstream author is the _same office_. SCPA compiles the roll and submits it to FDOR;
  FDOR certifies and republishes it. This is a **time-lagged, state-certified snapshot of the
  same appraiser's roll**, not a second independent measurement of the parcels. It will reliably
  catch roll drift, parcel lifecycle changes, and revaluation, but it will **not** catch a
  systematic SCPA measurement error — a wrong living area in SCPA is very likely wrong here too.
- **Coordinates are not an independent check at all.** Median CAMA-to-FDOR centroid distance is
  **0.01 m**, and 159,996 of 178,863 (89.45%) agree to six decimal places. The geometry shares
  lineage with the same county GIS parcel layer that produced CAMA's lat/long. Treat coordinate
  agreement as a null result, not as corroboration.

Net: valuable as a certification and freshness cross-check, and as a source of clean enrichment
columns. Not a substitute for a truly independent observation of the physical parcel.

---

## 3. Join key — direct equality, no normalization needed

This was the expected hard part and it turned out to be trivial. Measured on both sides:

| Check                       | CAMA `parcel_id` | FDOR `PARCEL_ID` |
| --------------------------- | ---------------- | ---------------- |
| Rows                        | 181,218          | 179,107          |
| Distinct values             | 181,218          | 179,107          |
| Length exactly 17           | 181,218 (100%)   | 179,107 (100%)   |
| Matches `^[0-9A-Z]{17}$`    | 181,218 (100%)   | 179,107 (100%)   |
| All-digit (no letters)      | 102,748          | —                |
| Leading/trailing whitespace | 0                | 0                |
| Lowercase characters        | 0                | 0                |

Both sides use the identical 17-character compact uppercase alphanumeric key. Roughly 43% of
keys contain letters (e.g. `1721295BG00000630`, `0921305BP0A000010`), so this is **not** a
numeric field — it must be carried as a string. Zero-padding a numeric cast would corrupt it.

**Normalization rule for the implementer:**

```sql
-- Join key. No dash stripping, no zero padding, no case folding required.
-- The defensive trim()/upper() are no-ops on current data but cost nothing.
ON upper(trim(cama.parcel_id)) = upper(trim(fdor.PARCEL_ID))
```

### Bonus: the key is self-describing, and it validates

Characters 1-6 of the parcel ID encode Section, Township, and Range:

```
PARCEL_ID  1821295020D000180
           18 = SEC 18
             21 = TWN 21S
               29 = RNG 29E
```

Verified against FDOR's discrete columns: **179,106 of 179,107 (99.9995%)** agree on all three.
The single exception is one record with `TWN='00'`, `RNG='00'` and a blank `SEC`.

This is a genuinely useful result and it has a consequence for §6: Township/Range/Section is
already recoverable from the CAMA parcel ID by substring. FDOR is more convenient, not required.

### Distinct Township/Range values present

`TWN`: 18S, 19S, 20S, 21S (plus one `00`) · `RNG`: 29E, 30E, 31E, 32E, 33E (plus one `00`)

---

## 4. Measured overlap

| Set                        | Count       | Share                          |
| -------------------------- | ----------- | ------------------------------ |
| CAMA total                 | 181,218     | —                              |
| FDOR total                 | 179,107     | —                              |
| **Matched (both sources)** | **178,863** | 98.70% of CAMA, 99.86% of FDOR |
| CAMA only                  | 2,355       | 1.30% of CAMA                  |
| FDOR only                  | 244         | 0.14% of FDOR                  |
| Union                      | 181,462     | —                              |

The net headline gap is 2,111 parcels, which matched the planning figure, but the two-sided
breakdown is the operationally useful number: **2,355 additions and 244 retirements**, not a
flat 2,111 shortfall.

### 4.1 The CAMA-only 2,355 — hypothesis tested, partly confirmed

The hypothesis was recent splits and new construction. The data supports drift, but the
dominant signal is **newly created parcels with no building on them**, not new construction.

| Signal                     | CAMA-only (n=2,355) | Full CAMA baseline (n=181,218) | Enrichment |
| -------------------------- | ------------------- | ------------------------------ | ---------- |
| **No `year_built` at all** | 803 (34.10%)        | 19,239 (10.62%)                | **3.21x**  |
| Has `year_built`           | 1,552 (65.90%)      | 161,979 (89.38%)               | 0.74x      |
| `year_built >= 2024`       | 63 (2.68%)          | 2,179 (1.20%)                  | **2.23x**  |
| `year_built >= 2020`       | 130 (5.52%)         | 7,827 (4.32%)                  | 1.28x      |
| Last sale in 2025 or later | 285 (12.10%)        | 11,216 (6.19%)                 | **1.96x**  |
| Median just value          | $328,688            | $329,761                       | ~equal     |

Reading: recent sales are ~2x over-represented and post-2024 construction ~2.2x
over-represented, both consistent with the drift story. But the strongest effect by far is that
a third of the CAMA-only parcels have **no year built at all**, versus a tenth of the baseline.
These are predominantly newly platted or newly split vacant lots that did not exist as separate
parcels when the 2025 roll was certified. Median just value being identical to baseline argues
against these being a distinct low-value junk class.

**No jurisdiction is excluded by either source.** All eight jurisdictions appear in the
CAMA-only set, roughly in proportion, with Sanford mildly over-represented:

| Jurisdiction                   | CAMA-only | % of CAMA-only | % of full CAMA |
| ------------------------------ | --------- | -------------- | -------------- |
| Unincorporated Seminole County | 1,301     | 55.24%         | 50.24%         |
| Sanford                        | 426       | 18.09%         | 12.44%         |
| Oviedo                         | 200       | 8.49%          | 7.90%          |
| Winter Springs                 | 163       | 6.92%          | 8.02%          |
| Altamonte Springs              | 80        | 3.40%          | 8.22%          |
| Longwood                       | 66        | 2.80%          | 3.56%          |
| Lake Mary                      | 63        | 2.68%          | 3.90%          |
| Casselberry                    | 56        | 2.38%          | 5.72%          |

### 4.2 The FDOR-only 244 are genuine retirements, not key mismatches

Spatially rechecked each of the 244 against every CAMA parcel to rule out a key-format problem:

- Only **13** have any CAMA parcel within 5 m.
- **174** have one within 50 m (i.e. an adjacent or absorbing parcel exists, as expected for a
  combine).
- 29 of 244 have a nonzero `ACT_YR_BLT`; median `JV` $140,000; 5 carry `PAR_SPLT > 0`.

These are 2025 parcels that were combined or retired before the current CAMA snapshot. They are
not join failures. That distinction matters — it means the 17-char key has effectively **zero**
format-driven miss rate.

---

## 5. Field agreement (measured on the 178,863 matched parcels)

"Comparable" excludes rows where either side is null; FDOR encodes missing numerics as `0`, so
`ACT_YR_BLT`, `EFF_YR_BLT`, `TOT_LVG_AR`, `SALE_PRC1`, `SALE_YR1` were passed through
`nullif(x, 0)` before comparison.

| Field (FDOR → CAMA)                     | Comparable | Exact                      | Exact %             | Tolerance band            | Verdict               |
| --------------------------------------- | ---------- | -------------------------- | ------------------- | ------------------------- | --------------------- |
| `TOT_LVG_AR` → `total_living_area`      | 152,321    | 151,080                    | **99.19%**          | 544 rows (0.36%) off >10% | Reconcile             |
| `ACT_YR_BLT` → `year_built`             | 159,270    | 156,792                    | **98.44%**          | 98.54% within ±1 yr       | Reconcile             |
| `DOR_UC` → `dor_code` (2-digit)         | 178,863    | 176,862                    | **98.88%**          | —                         | Reconcile             |
| `EFF_YR_BLT` → `max_effective_year_blt` | 159,270    | 152,786                    | **95.93%**          | 96.06% within ±1 yr       | Reconcile, wider band |
| `OWN_NAME` → `owner_name` (prefix)      | 178,826    | 162,292                    | **90.81%**          | alnum-exact only 66.88%   | Advisory only         |
| `SALE_*` → sales, **qualified only**    | 9,215      | 8,698 (yr) / 7,867 (price) | **94.39% / 85.37%** | —                         | Reconcile, gated      |
| `SALE_*` → sales, unqualified           | 7,652      | 151 (yr)                   | **1.97%**           | —                         | Do not reconcile      |
| `JV` → `total_just_value`               | 178,863    | 14,771                     | **8.26%**           | 96.63% within 25%         | Band-only             |
| `AV_SD` → `assessed_value`              | 178,863    | 12,403                     | **6.93%**           | —                         | Do not reconcile      |
| centroid → `latitude`/`longitude`       | 178,863    | 159,996 @6dp               | **89.45%**          | median dist **0.01 m**    | Not independent       |

### 5.1 Just value — genuine annual revaluation, not a formatting artifact

Only 8.26% exact, which looks alarming until you look at the shape. Cumulative agreement:

| Band           | Cumulative % | Rows      |
| -------------- | ------------ | --------- |
| Exact          | 8.26%        | 14,771    |
| within 1%      | 44.23%       | 79,117    |
| within 5%      | 72.21%       | 129,158   |
| within 10%     | 86.40%       | 154,545   |
| within 25%     | 96.63%       | 172,840   |
| **beyond 25%** | **3.37%**    | **6,023** |

Direction is two-sided: CAMA higher on 66,187, CAMA lower on 97,905, equal on 14,771. Median
delta **-0.218%**, mean **+7.25%** — a near-zero median with a positive mean, i.e. a tight
symmetric core plus a right tail.

Sampled disagreements confirm the cause is revaluation, not a mapping bug. In every sampled
row the `year_built` and `total_living_area` agree exactly while `JV` moves a few percent:

| parcel_id         | CAMA JV | FDOR JV | Δ%     | yr_built (C/F) | living area (C/F) |
| ----------------- | ------- | ------- | ------ | -------------- | ----------------- |
| 36193052000001700 | 201,794 | 197,443 | +2.2%  | 1950 / 1950    | 1471 / 1471       |
| 2221295070G000070 | 525,547 | 463,601 | +13.4% | 1972 / 1972    | 2115 / 2115       |
| 17203050500000500 | 310,881 | 348,371 | -10.8% | 1991 / 1991    | 1600 / 1600       |
| 0721315060600006E | 245,197 | 261,256 | -6.1%  | 2016 / 2016    | 1447 / 1447       |

Same parcel, same building, different assessment year. This is CAMA's current working roll
against the certified 2025 roll.

Agreement is strongly value-banded, which is the clean confirmation:

| FDOR JV band     | n       | Exact %    | within 1% | Median Δ% |
| ---------------- | ------- | ---------- | --------- | --------- |
| ≤ $100 (nominal) | 8,897   | **92.67%** | 92.67%    | 0.00%     |
| < $50k           | 3,755   | 56.56%     | 57.12%    | 0.00%     |
| < $250k          | 41,930  | 7.72%      | 31.19%    | -0.64%    |
| < $600k          | 101,734 | 0.76%      | 47.12%    | -0.33%    |
| ≥ $600k          | 22,547  | 1.73%      | 34.22%    | +1.43%    |

Nominal $100 parcels agree 92.67% because they are never revalued. Everything with a real
market value gets reassessed annually. New construction diverges more, as expected: parcels
with `NCONST_VAL > 0` (n=2,588) hit **0.00%** exact versus 8.38% for the rest.

### 5.2 Assessed value — a definition mismatch, do not reconcile

`AV_SD` is the school-district assessed value; CAMA's `assessed_value` is not the same concept.
Best-case exact agreement is 6.93%. For reference, `AV_NSD` does slightly worse (11,863) and
`TV_SD` against CAMA `taxable_value` gives 17,466. Also note `AV_SD = AV_NSD` for only 147,364
of 179,107 rows, so the school/non-school split is itself material. These are not the same
metric and should not be compared.

### 5.3 Sales — resolved by qualification code, and it is a clean result

Two separate problems, both solved.

**Problem 1: FDOR sales are a rolling window, not a lifetime history.** `SALE_YR1` contains
**only 2024 (13,465) and 2025 (5,368)**. 160,275 of 179,107 parcels have `SALE_PRC1 = 0`. The
NAL sale fields cover the assessment cycle, not the parcel's last transaction ever. CAMA's
`last_sale_date` is a lifetime most-recent. These are different metrics with different temporal
classes and must never be compared naively.

**Problem 2: on the overlap, FDOR records unqualified instruments that CAMA excludes.** Raw
sale-year agreement was only 51.8%, with CAMA _older_ than FDOR on 7,217 rows — the wrong
direction for a staleness story. `QUAL_CD1` explains it completely:

| `QUAL_CD1`       | Rows  | CAMA older | Interpretation                 |
| ---------------- | ----- | ---------- | ------------------------------ |
| 02 (qualified)   | 7,976 | **3**      | Arm's-length sale — both agree |
| 01 (qualified)   | 1,239 | 18         | Arm's-length sale — both agree |
| 30 (unqualified) | 3,173 | 2,602      | Non-market transfer            |
| 14 (unqualified) | 2,973 | 2,556      | Non-market transfer            |
| 11 (unqualified) | 2,441 | 1,707      | Non-market transfer            |

Restricting to qualified sales (`QUAL_CD1 IN ('01','02')`):

- Sale year: **8,698 / 9,215 = 94.39%** exact
- Sale price: **7,867 / 9,215 = 85.37%** exact

Restricting to unqualified (11/14/30): **151 / 7,652 = 1.97%**.

The unqualified rows are quitclaims and related-party transfers recorded at $100 — visible in
the samples, where `f_sp = 100` and `VI_CD1 = 'I'`. CAMA is _correct_ to hold the last market
sale. So there is no data defect here at all; there is a qualification filter that the
reconciliation must apply. **Gate every sale comparison on `QUAL_CD1 IN ('01','02')`.**

### 5.4 Owner name — truncation makes exact comparison meaningless

`OWN_NAME` is capped at 30 characters (42,860 rows sit exactly at 30; CAMA has 50,287 rows
longer than 30). Measured three ways:

- Raw string equality: 82,660 / 178,826 = 46.22%
- Punctuation/space-insensitive equality: 119,606 = 66.88%
- **FDOR value is a prefix of the CAMA value (truncation-aware): 162,292 = 90.81%**

Only the prefix measure is meaningful. Even at 90.81% this is too noisy for reconciliation —
the residual mixes real ownership change with formatting divergence and there is no way to
separate them from these two sources alone. Advisory signal only.

### 5.5 DOR use code — needs a 2-digit truncation

CAMA stores `dor_code` as a display string with a variable-width numeric prefix
(`01 - SINGLE FAMILY`, `0130 - SINGLE FAMILY WATERFRONT`). FDOR stores a 3-char zero-padded
code (`001`, `080`). CAMA's 4-digit values are SCPA sub-classifications with no FDOR equivalent.

```sql
-- Compare on the first two digits only.
try_cast(substr(regexp_extract(cama.dor_code, '^([0-9]+)', 1), 1, 2) AS INT)
  = try_cast(fdor.DOR_UC AS INT)
```

- 2-digit rule: **176,862 / 178,863 = 98.88%** agree
- Full-prefix rule: 140,088 = 78.32% (fails on CAMA's 4-digit sub-codes — do not use)

Largest residual disagreements: CAMA `01` vs FDOR `000` (966 rows — improved vs vacant
classification differing across the roll year), CAMA `94` vs FDOR `010` (414), CAMA `00` vs
FDOR `001` (59).

---

## 6. Enrichment fields — coverage confirmed

All six requested fields, plus the two FDOR-only value fields, measured across all 179,107 rows:

| Field        | Non-null / non-blank                  | Coverage     |
| ------------ | ------------------------------------- | ------------ |
| `TWN`        | 179,107                               | **100.000%** |
| `RNG`        | 179,107                               | **100.000%** |
| `SEC`        | 179,106                               | **99.999%**  |
| `CENSUS_BK`  | 179,106                               | **99.999%**  |
| `OWN_CITY`   | 178,622                               | **99.729%**  |
| `OWN_STATE`  | 178,609                               | **99.722%**  |
| `OWN_ZIPCD`  | 178,182                               | **99.484%**  |
| `NCONST_VAL` | 179,107 populated; **2,590** rows > 0 | 100% present |

Coverage is excellent across the board. Two caveats on how much this actually buys:

**Owner state/ZIP: the parsing win is real but small, and FDOR is not more correct.** CAMA's
`mailing_city_state_zip` blob (`ALTAMONTE SPG, FL 32714-1205`) parses cleanly far more often
than expected:

| Measure                                         | Count             | Rate   |
| ----------------------------------------------- | ----------------- | ------ |
| CAMA blob yields a 2-char state                 | 177,960 / 178,863 | 99.50% |
| CAMA-parsed state agrees with `OWN_STATE`       | 175,638 / 178,863 | 98.20% |
| Rows where FDOR fills a state CAMA cannot parse | **495**           | 0.28%  |
| CAMA blob yields a 5-digit ZIP                  | 177,946 / 178,863 | 99.49% |
| CAMA-parsed ZIP agrees with `OWN_ZIPCD`         | 167,723 / 178,863 | 93.77% |
| Rows where FDOR fills a ZIP CAMA cannot parse   | **101**           | 0.06%  |

FDOR reports 11,611 non-Florida owners, so the out-of-area test is well supported. But the
2,322 state disagreements run in _both_ directions (CAMA `FL` / FDOR `NY` on 102; CAMA `TX` /
FDOR `FL` on 95; CAMA `CA` / FDOR `FL` on 92), which is mailing-address churn over the year.
On a changed address, the nightly source is more current by construction. See §7.

**Township/Range/Section: convenient, not necessary.** As shown in §3, all three are recoverable
from CAMA's `parcel_id` by substring with 99.9995% consistency. FDOR's version is cleaner and
needs no parsing, so prefer it — but it is not a capability the pipeline lacks.

`NCONST_VAL` and `CENSUS_BK` have no CAMA equivalent and are genuine FDOR-only enrichment.
`NCONST_VAL` is directly useful: it flags the 2,590 new-construction parcels that also account
for the worst just-value divergence (0.00% exact), so it doubles as a reconciliation suppressor.

---

## 7. Recommended precedence policy

The proposed split is **supported on four of five points. One needs revision.**

### Confirmed as proposed

| Field                                 | Winner   | Measured justification                                                                                                                                       |
| ------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Parcel identity                       | **CAMA** | CAMA is a strict superset on live parcels: 2,355 CAMA-only vs 244 FDOR-only, and the 244 are verified retirements (only 13 have any CAMA parcel within 5 m). |
| Roof age (`year_built`, effective yr) | **CAMA** | 98.44% / 95.93% agreement means FDOR adds no correction at scale; CAMA is nightly. Use FDOR as a validator, not a source.                                    |
| Sales                                 | **CAMA** | FDOR only covers 2024-2025 (160,275 of 179,107 have no sale) and mixes in unqualified transfers. CAMA correctly holds the last market sale.                  |
| Values (`JV`)                         | **CAMA** | FDOR is the certified 2025 roll; CAMA is the current working roll. Only 8.26% exact, and sampled diffs are pure revaluation.                                 |
| Coordinates                           | **CAMA** | Moot — median separation is 0.01 m. Not an independent check.                                                                                                |
| `TWN`/`RNG`/`SEC`                     | **FDOR** | 100%/100%/99.999% clean discrete columns, no parsing. (Fallback: substring CAMA `parcel_id[1:6]`, 99.9995% consistent.)                                      |

### Needs revision: owner state / ZIP / city

**Proposed:** FDOR wins. **Recommended:** CAMA wins on value; FDOR wins on _shape_.

FDOR's `OWN_STATE`/`OWN_ZIPCD`/`OWN_CITY` are clean discrete columns and should absolutely be
carried as the parse-free representation. But they are an August-2025 snapshot. Where both sides parse and
disagree (2,322 on state, 10,223 on ZIP) the disagreement is bidirectional mailing-address
churn, and the nightly source is necessarily the more current one. Letting FDOR win would
knowingly regress ~1.8% of owner states to year-old values.

Concretely:

1. Take the CAMA-parsed state/ZIP as the value of record (99.50% / 99.49% parse rate).
2. Use FDOR to **backfill only** where the CAMA blob will not parse — 495 states (0.28%) and
   101 ZIPs (0.06%).
3. Use FDOR as a **validation cross-check**, not an override: a state mismatch is a signal that
   ownership or mailing address changed within the last year, which is itself a useful feature.
4. Carry `OWN_CITY` from FDOR as the discrete city column, since CAMA's city segment is the
   least reliable part of the blob and city is not used for the out-of-area test.

The out-of-area-owner test still becomes an exact comparison — it just should be driven by
CAMA's parsed state with FDOR as the tiebreaker and auditor.

### Anomaly thresholds

Tuned so each rule fires on a reviewable volume rather than on normal annual drift:

| Field                    | Raise anomaly when                       | Volume at this threshold        | Rationale                                                                                                              |
| ------------------------ | ---------------------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `total_living_area`      | Any exact mismatch >10%                  | **544** (0.36%)                 | 99.19% exact; a >10% gap is a real measurement conflict.                                                               |
| `year_built`             | Differs by >1 year                       | **2,326** (1.46% of comparable) | 98.54% agree within ±1; larger gaps are data conflicts.                                                                |
| `dor_code` (2-digit)     | Any mismatch                             | **2,001** (1.12%)               | 98.88% agree; mismatches concentrate in vacant/improved reclassification.                                              |
| `total_just_value`       | Differs by **>25%**                      | **6,023** (3.37%)               | 96.63% fall within 25%. Do not alert below 25% — that is annual revaluation, and even 1% would fire on 55% of parcels. |
| Qualified sale price     | Mismatch where `QUAL_CD1 IN ('01','02')` | **1,348** (14.63% of 9,215)     | 85.37% exact on qualified sales only.                                                                                  |
| Parcel presence          | In FDOR, absent from CAMA                | **244**                         | Should be retirements; a spike means a key or ingest regression.                                                       |
| `max_effective_year_blt` | Differs by >1 year                       | **6,276** (3.94%)               | Noisier than actual year built; wider band required.                                                                   |

Suppress the just-value rule where `NCONST_VAL > 0` (2,588 matched rows) — those parcels
diverge 100% of the time by construction and will only generate noise.

### Too noisy to reconcile at all

- **`owner_name`** — 30-char truncation caps meaningful agreement at 90.81% (prefix match) and
  46.22% raw. Cannot separate formatting from real change. Advisory only.
- **`assessed_value` / `AV_SD`** — different metric (school-district basis). 6.93% exact.
  Comparing these is a category error, not a data-quality signal.
- **Unqualified sales** (`QUAL_CD1` not in 01/02) — 1.97% agreement by design.
- **Coordinates** — shared lineage, median 0.01 m. Agreement here proves nothing.

---

## 8. Ingest cost and method — measured

Naive `resultOffset` paging is a trap on this service. It degrades badly with offset depth:

| Offset reached | Elapsed | Marginal rate |
| -------------- | ------- | ------------- |
| 20,000         | 177 s   | ~8.8 s/page   |
| 40,000         | 315 s   | ~13.8 s/page  |
| 60,000         | 685 s   | ~37.0 s/page  |
| 80,000         | 1,195 s | ~51.0 s/page  |

Extrapolated to completion that is well over an hour, and it gets worse per page. The fix is to
window on `OBJECTID` instead of using an offset. Seminole's `OBJECTID` range is nearly
contiguous — 9,508,715 to 9,689,308, a span of 180,594 for 179,107 rows — so fixed-width
windows are near-perfectly packed:

```
where=CO_NO=69 AND OBJECTID>=<lo> AND OBJECTID<<lo+1500>
```

**Measured full-county extract:**

| Metric                       | Value                             |
| ---------------------------- | --------------------------------- |
| Wall clock                   | **65.3 s**                        |
| Rows                         | 179,107 / 179,107 (complete)      |
| HTTP requests                | 121 (+2 for metadata and count)   |
| Window size                  | 1,500 OBJECTIDs                   |
| Parallel workers             | 8                                 |
| Raw JSON transferred         | 129,766,617 bytes (**123.8 MiB**) |
| Failed requests / retries    | **0**                             |
| Fields requested             | 37 of 120, plus point geometry    |
| Compressed on disk (Parquet) | ~40 MiB equivalent                |

Budget **~70 s and ~125 MiB** per full Seminole refresh, on 37 fields. Pulling all 120 fields
would raise the payload roughly 2-3x; request only what is needed.

Operational notes for the implementer:

- Send a realistic browser User-Agent. This was done on every request in this investigation.
- Keep the `OBJECTID` window approach. Re-derive min/max per county via `outStatistics` rather
  than hardcoding, since the service is republished annually.
- Retain the offset sub-paging fallback for any window that returns
  `exceededTransferLimit: true` (a 1,500-wide window cannot exceed 2,000 on current data, but a
  future republish could change OBJECTID density). Zero windows needed it this run.
- FDOR encodes missing numerics as `0`, not null. Apply `nullif(x, 0)` on `ACT_YR_BLT`,
  `EFF_YR_BLT`, `TOT_LVG_AR`, `SALE_PRC1`, `SALE_YR1`, `OWN_ZIPCD` at ingest or every
  aggregate will be wrong.
- Several string fields use a single space `' '` as the empty value rather than null or `''`
  (`PARCEL_ID_`, `ALT_KEY`, `PHY_ADDR1`). Trim before testing for emptiness.
- `PARCEL_ID` must stay a string. ~43% of Seminole keys contain letters.

---

## 9. Multi-county reuse — the same code path, one parameter

This is a statewide service, not a Seminole endpoint. The county is a single query parameter,
and the schema, key format, and paging strategy are identical for all 67 counties. Verified
live: `CO_NO=46` (Lee) returns 556,100 records from the same layer with the same field set.

So onboarding another Florida county is `CO_NO=<n>` plus a fresh `OBJECTID` min/max lookup —
no new adapter, no new parser, no new join rule. Two caveats worth carrying forward:

- Do **not** derive `CO_NO` from FDOR's published NAL filenames; they contain at least one
  demonstrable error (Seminole published as `58`, colliding with Orange). Use `CO_NO` from the
  records, corroborated by the `STATE_PAR_` prefix (`C69-` for Seminole).
- Lee at 556,100 records is ~3.1x Seminole, so budget ~215 MiB and ~200 s for the largest
  counties on the same 37-field projection. Window count scales linearly with parcel count.

The parcel-ID normalization rule (§3) is the one thing to re-verify per county: Seminole's
17-char compact key happens to be byte-identical across both sources, but other counties format
parcel identifiers differently and the SEC/TWN/RNG substring positions are a Seminole
convention, not a statewide guarantee.

---

## 10. Bottom line

- A second source exists, is free, is bulk-accessible, and covers 99.86% of our parcels:
  **FDOR Cadastral Centroids 2025, `CO_NO=69`, 179,107 records, 65 s, 124 MiB.**
- The join is **direct string equality on a 17-char key** — 178,863 matches with effectively
  zero format-driven miss rate.
- Independence is **real but bounded**: separate certification and separate lineage artifacts,
  but the same originating office, and the coordinates are not independent at all.
- The structural fields reconcile strongly: **living area 99.19%, year built 98.44%, land use
  98.88%**.
- The valuation fields do not reconcile exactly (**8.26%**) and should not be expected to — that
  is a 2025-certified versus current-working-roll comparison, confirmed by sampled rows where
  building attributes match exactly and only value moves.
- Two initial framings needed correction against the data: **sales require a `QUAL_CD1` gate**
  (94.39% once gated, 51.8% ungated), and **FDOR should not win on owner state/ZIP** because it
  is a year-old snapshot.
- The same code path onboards any Florida county by changing one parameter.
