"""FDOR-to-CAMA reconciliation: the pure half.

The second parcel source is FDOR's certified 2025 NAL tax roll joined to parcel
centroids. Reconciling it against the nightly CAMA extract answers one question — did
the county's current working roll drift away from the roll the state certified — and it
is only useful if the answer is compared against a known-good answer. This module holds
that known-good answer.

Every baseline below was measured against live data on 2026-09-01 and is written up in
``docs/seminole-second-source-reconciliation.md``. They are not targets and not
estimates: they are what the two sources actually said. The point of pinning them is
that the interesting failure here is silent. A join that breaks on a key-format change,
a ``nullif`` that stops being applied, a sale comparison that loses its qualification
gate — none of those make the run fail. They make the agreement numbers move. So the
numbers are asserted, and a run that cannot reproduce them stops.

Three of the comparisons are deliberately *not* reconciled, and the reasons are as
load-bearing as the ones that are:

* **Just value** agrees exactly on 8.26% of parcels, which looks like a defect and is
  not one. CAMA is the current working roll and FDOR is the certified 2025 roll, so
  almost every parcel with a real market value has been reassessed between them. The
  measurable claim is the tolerance band — 96.63% within 25% — not the exact rate.
* **Sales** agree on 51.8% raw, which is meaningless. FDOR's NAL sale fields record the
  assessment cycle's instruments including unqualified ones — quitclaims and
  related-party transfers booked at $100 — while CAMA holds the last market sale. Gated
  on ``QUAL_CD1``, agreement is 94.39% on qualified sales and 1.97% on unqualified. Both
  numbers are asserted, because the 1.97% is the evidence that the gate is still doing
  something.
* **Coordinates** agree to six decimal places on 89.45% of parcels at a median
  separation of 0.01 m. That is shared GIS lineage, not corroboration. It is recorded as
  an explicit null result so nobody later reads it as a cross-check that passed.

Nothing here imports Spark. The Glue job counts rows and hands the counts in.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Final

#: Document schema version. A consumer that pins this must fail loudly rather than
#: misread a future shape, exactly as with ``change_set.json``.
RECONCILIATION_VERSION: Final = 1

#: FDOR's sale-qualification codes for an arm's-length transfer.
#:
#: The single most consequential constant in this module. Ungated, sale-year agreement
#: is 51.8% and CAMA looks *older* than FDOR on 7,217 rows — the wrong direction for a
#: staleness story, and the tell that the comparison was wrong rather than the data.
#: Gated, it is 94.39%. Codes 11, 14, and 30 are the dominant unqualified classes and
#: account for essentially all of the disagreement.
QUALIFIED_SALE_CODES: Final[tuple[str, ...]] = ("01", "02")

#: The unqualified codes the 1.97% baseline was measured on.
#:
#: Enumerated rather than expressed as "not qualified", and the difference is not
#: cosmetic. 11, 14, and 30 are the three dominant non-market classes — quitclaims and
#: related-party transfers booked at $100 — and they are what the baseline covers. Taking
#: the complement of :data:`QUALIFIED_SALE_CODES` instead sweeps in the sparse remaining
#: codes, which behave much more like market sales, and scores 5.61% against a 1.97%
#: baseline. The control figure only controls if it is measured on the same population.
UNQUALIFIED_SALE_CODES: Final[tuple[str, ...]] = ("11", "14", "30")

#: FDOR numeric fields where a missing value is encoded as ``0`` rather than null.
#:
#: Applying ``nullif(x, 0)`` to these at ingest is not a nicety. 160,275 of 179,107
#: parcels carry ``SALE_PRC1 = 0`` because they had no sale in the assessment cycle, and
#: 19,837 carry ``ACT_YR_BLT = 0`` because they have no building. Averaged or compared as
#: zeros, every aggregate built on them is quietly wrong and nothing raises.
ZERO_IS_NULL_FIELDS: Final[tuple[str, ...]] = (
    "ACT_YR_BLT",
    "EFF_YR_BLT",
    "TOT_LVG_AR",
    "SALE_PRC1",
    "SALE_YR1",
    "SALE_PRC2",
    "SALE_YR2",
    "OWN_ZIPCD",
)

#: FDOR string fields whose empty value is a single space rather than ``''`` or null.
#: Trim before testing for emptiness or every one of them reads as populated.
SPACE_IS_BLANK_FIELDS: Final[tuple[str, ...]] = (
    "QUAL_CD1",
    "QUAL_CD2",
    "VI_CD1",
    "SALE_MO1",
    "OWN_STATE",
    "OWN_CITY",
    "SEC",
    "TWN",
    "RNG",
)

#: Which source wins per field on the published row, and why.
#:
#: Four of these were proposed and confirmed. The fifth — owner state, ZIP, and city —
#: was proposed as FDOR and is deliberately reversed here. FDOR's discrete columns are
#: cleaner to read than CAMA's ``mailing_city_state_zip`` blob, but that blob parses to a
#: state on 99.50% of rows and FDOR rescues only 495 of them (0.28%). Against that,
#: 2,322 state disagreements run in *both* directions, which is a year of mailing-address
#: churn. Letting a year-old snapshot win would knowingly regress ~1.8% of owner states
#: to stale values in exchange for a 0.28% backfill. FDOR is a backfill and a validator
#: on these fields, never an override.
PRECEDENCE: Final[Mapping[str, str]] = {
    "parcel_identity": "cama",
    "roof_age": "cama",
    "sales": "cama",
    "values": "cama",
    "coordinates": "cama",
    "owner_state": "cama",
    "owner_zip": "cama",
    "owner_city": "cama",
    # Not a contest: characters 1-6 of the CAMA parcel id encode all three and agree with
    # FDOR's discrete columns on 179,106 of 179,107 rows. Derived from the id, validated
    # against FDOR. No second source is needed for this at all.
    "section_township_range": "derived-from-parcel-id",
}

#: Measured set sizes on 2026-09-01.
OVERLAP_BASELINES: Final[Mapping[str, int]] = {
    "matched": 178_863,
    "camaOnly": 2_355,
    "fdorOnly": 244,
}

#: Fractional tolerance per overlap set, and the asymmetry is intentional.
#:
#: ``matched`` is the stable number and a 2% move in it means the join broke. The two
#: one-sided sets are small and one of them grows by construction: FDOR is a fixed
#: August-2025 snapshot while CAMA adds parcels nightly, so ``camaOnly`` climbs all year
#: as lots are platted and split. A tight bound on it would fire on nothing but the
#: calendar. ``fdorOnly`` is bounded the same way for symmetry — it should only shrink,
#: and a *spike* there is the regression worth catching.
OVERLAP_TOLERANCE: Final[Mapping[str, float]] = {
    "matched": 0.02,
    "camaOnly": 0.50,
    "fdorOnly": 0.50,
}

#: Measured agreement rates on the 178,863 matched parcels.
#:
#: Keyed by the metric each one names, not by field, because two of the fields carry more
#: than one rate: just value is pinned on both its exact rate and its 25% band, and sales
#: are pinned on both sides of the qualification gate.
AGREEMENT_BASELINES: Final[Mapping[str, float]] = {
    "total_living_area": 0.9919,
    "dor_code": 0.9888,
    "year_built": 0.9844,
    "max_effective_year_blt": 0.9593,
    "owner_name_prefix": 0.9081,
    "total_just_value_exact": 0.0826,
    "total_just_value_within_25pct": 0.9663,
    "qualified_sale_year": 0.9439,
    "qualified_sale_price": 0.8537,
    "unqualified_sale_year": 0.0197,
    "assessed_value": 0.0693,
    "coordinates_identical_6dp": 0.8945,
    "section_township_range": 0.999994,
}

#: Absolute tolerance on an agreement rate, in fractional points.
#:
#: Two points is wide enough to absorb a year of ordinary roll drift on the structural
#: fields — those move by tenths of a point, not by points — and narrow enough that a
#: dropped ``nullif``, a lost qualification gate, or a land-use comparison that forgot to
#: truncate to two digits all land well outside it. The 2-digit truncation is the sharpest
#: example: comparing CAMA's full numeric prefix instead scores 78.32% against a baseline
#: of 98.88%.
AGREEMENT_TOLERANCE: Final = 0.02

#: Rows that may disagree beyond a field's tolerance band before it is an anomaly.
#:
#: Tuned so each rule fires on a reviewable volume rather than on normal annual drift.
#: The just-value rule is the one that needed the most care: at a 1% threshold it would
#: fire on 55% of the county, which is not an alert, it is the annual revaluation.
ANOMALY_THRESHOLDS: Final[Mapping[str, int]] = {
    "total_living_area_beyond_10pct": 544,
    "year_built_beyond_1yr": 2_326,
    "max_effective_year_blt_beyond_1yr": 6_276,
    "dor_code_mismatch": 2_001,
    "total_just_value_beyond_25pct": 6_023,
    "qualified_sale_price_mismatch": 1_348,
}

#: Leading run of digits in CAMA's ``dor_code`` display string.
_LEADING_DIGITS: Final = re.compile(r"^\s*([0-9]+)")

#: FDOR's ``TWN``/``RNG`` carry a direction suffix (``21S``, ``29E``); the parcel id does not.
_TRAILING_DIRECTION: Final = re.compile(r"[A-Z]$")

#: Everything the owner-name comparison ignores: punctuation, spacing, and separators.
_NON_ALPHANUMERIC: Final = re.compile(r"[^A-Z0-9]")


class ReconciliationDriftError(RuntimeError):
    """A measured reconciliation figure moved away from its pinned baseline.

    Raised rather than logged. The whole value of pinning these numbers is that they are
    the only signal for a class of bug that otherwise produces a successful run with
    quietly wrong output, so the run has to stop.
    """


@dataclass(frozen=True)
class Overlap:
    """Set sizes from the parcel-id join."""

    cama_total: int
    fdor_total: int
    matched: int
    cama_only: int
    fdor_only: int


@dataclass(frozen=True)
class FieldComparison:
    """One field's agreement, measured only on rows where both sides have a value.

    ``comparable`` excludes rows where either side is null — which, on the FDOR side,
    means *after* the zero-to-null conversion. Counting a missing living area as a
    disagreement would make the rate a coverage statistic rather than an agreement one.

    ``beyond_tolerance`` is the anomaly count: rows outside the field's band, which is
    not the same as rows that are not exact. Year built agrees exactly on 98.44% but
    within a year on 98.54%, and only the second figure is worth alerting on.
    """

    comparable: int
    exact: int
    beyond_tolerance: int = 0


@dataclass(frozen=True)
class JustValueBands:
    """Cumulative just-value agreement, which is the only honest way to report it.

    An exact-match rate of 8.26% describes a comparison between two different assessment
    years, not a data quality problem. The band distribution is what shows that: a tight
    symmetric core (median delta -0.218%) with a right tail, 96.63% inside 25%.
    """

    comparable: int
    exact: int
    within_1pct: int
    within_5pct: int
    within_10pct: int
    within_25pct: int


@dataclass(frozen=True)
class SaleComparison:
    """Sale agreement on each side of the ``QUAL_CD1`` gate.

    Both sides are reported because the unqualified rate is the evidence that the gate is
    still applied. If it ever climbs towards the qualified rate, the gate has been lost
    and the qualified figure is no longer measuring what it claims to.
    """

    qualified_comparable: int
    qualified_year_exact: int
    qualified_price_exact: int
    unqualified_comparable: int
    unqualified_year_exact: int


@dataclass(frozen=True)
class OwnerComparison:
    """Owner-field agreement, and the size of the backfill FDOR actually buys.

    ``OWN_NAME`` is hard-truncated at 30 characters, so raw equality tops out at 46.22%
    and only the truncation-aware prefix measure (90.81%) means anything — and even that
    is advisory, because the residual mixes real ownership change with formatting
    divergence and these two sources cannot separate them.
    """

    name_comparable: int
    name_prefix_match: int
    state_backfilled: int
    zip_backfilled: int
    state_disagreements: int
    zip_disagreements: int


@dataclass(frozen=True)
class NullResults:
    """Comparisons recorded so they are not mistaken for corroboration later.

    Coordinates share GIS lineage with CAMA's own lat/long — median separation 0.01 m —
    so their agreement proves nothing about either source. Section/township/range is the
    opposite case: a genuine validation, but of a value derived from the CAMA parcel id
    rather than sourced from FDOR.
    """

    coordinates_compared: int
    coordinates_identical_6dp: int
    section_township_range_compared: int
    section_township_range_agree: int


def ratio(numerator: int, denominator: int) -> float:
    """Agreement rate, with an empty denominator reported as zero rather than raising."""
    if denominator <= 0:
        return 0.0
    return numerator / denominator


def cama_dor_code(display: str | None) -> int | None:
    """Reduce CAMA's ``dor_code`` display string to the 2-digit code FDOR publishes.

    CAMA writes a variable-width numeric prefix followed by a label — ``01 - SINGLE
    FAMILY``, ``0130 - SINGLE FAMILY WATERFRONT``. The 4-digit values are SCPA
    sub-classifications with no FDOR equivalent, so only the first two digits are
    comparable. Truncating is what takes agreement from 78.32% to 98.88%; comparing the
    full prefix is the single easiest way to make this reconciliation look broken.
    """
    if display is None:
        return None
    match = _LEADING_DIGITS.match(display)
    if match is None:
        return None
    return int(match.group(1)[:2])


def fdor_dor_code(code: str | None) -> int | None:
    """Parse FDOR's zero-padded 3-character ``DOR_UC`` (``001``, ``080``) to an int."""
    if code is None:
        return None
    stripped = code.strip()
    if not stripped.isdigit():
        return None
    return int(stripped)


def owner_name_key(value: str | None) -> str | None:
    """Reduce an owner name to the form the 90.81% prefix baseline was measured on.

    Three measures were taken on this field and only the third means anything. Raw
    equality scores 46.22%, because ``OWN_NAME`` is hard-capped at 30 characters and
    50,287 CAMA names are longer. Punctuation- and space-insensitive equality scores
    66.88%, which recovers the formatting divergence but still counts every truncation as
    a disagreement. Testing the FDOR value as a *prefix* of the CAMA value on that same
    normalised form scores 90.81%, and that is the only one of the three that measures
    ownership rather than an artifact of the export.

    So the normalisation and the prefix test are one measure, not two, and applying the
    prefix test to unnormalised strings is not a weaker version of it — it scores 67.66%,
    which lands close enough to the punctuation-insensitive figure to look plausible while
    measuring something else entirely.

    Returns ``None`` for a value with no alphanumeric content, which keeps it out of the
    comparable population rather than letting an empty string prefix-match everything.
    """
    if value is None:
        return None
    key = _NON_ALPHANUMERIC.sub("", value.upper())
    return key or None


def section_township_range(parcel_id: str | None) -> tuple[str, str, str] | None:
    """Decode section, township, and range from characters 1-6 of the parcel id.

    The Seminole 17-character key is self-describing: ``1821295020D000180`` is section 18,
    township 21, range 29. Verified against FDOR's discrete columns on 179,106 of 179,107
    rows — the lone exception carries ``TWN='00'``, ``RNG='00'`` and a blank ``SEC``.

    This is why the precedence table lists section/township/range as derived rather than
    sourced. FDOR's columns are cleaner and need no parsing, but they are not a capability
    the pipeline lacks, and preferring them would put an annual snapshot in the path of a
    value the nightly key already carries.

    Note that the substring positions are a Seminole convention, not a statewide one. A
    second county must re-verify this before reusing it.
    """
    if parcel_id is None:
        return None
    key = parcel_id.strip().upper()
    if len(key) < 6 or not key[:6].isdigit():
        return None
    return (key[0:2], key[2:4], key[4:6])


def fdor_section_township_range(
    sec: str | None, twn: str | None, rng: str | None
) -> tuple[str, str, str] | None:
    """Normalise FDOR's discrete columns onto the parcel id's 2-digit representation.

    Two shape differences have to be absorbed. ``SEC`` is unpadded (``9``, not ``09``)
    while the parcel id is fixed-width, and ``TWN``/``RNG`` carry a direction suffix
    (``21S``, ``29E``) that the id does not. Both are formatting, not disagreement.
    """
    if sec is None or twn is None or rng is None:
        return None
    section = sec.strip()
    township = _TRAILING_DIRECTION.sub("", twn.strip().upper())
    range_ = _TRAILING_DIRECTION.sub("", rng.strip().upper())
    if not (section.isdigit() and township.isdigit() and range_.isdigit()):
        return None
    return (section.zfill(2), township.zfill(2), range_.zfill(2))


#: Separator for the flattened section/township/range key.
_STR_SEPARATOR: Final = "|"


def section_township_range_key(parcel_id: str | None) -> str | None:
    """Flatten :func:`section_township_range` to one comparable string.

    Spark compares scalars far more comfortably than tuples, and a single UDF returning
    ``"18|21|29"`` keeps the tested implementation the shipped one rather than growing a
    second copy of the parsing in Spark SQL.
    """
    parts = section_township_range(parcel_id)
    return None if parts is None else _STR_SEPARATOR.join(parts)


def fdor_section_township_range_key(
    sec: str | None, twn: str | None, rng: str | None
) -> str | None:
    """Flatten :func:`fdor_section_township_range` onto the same key shape."""
    parts = fdor_section_township_range(sec, twn, rng)
    return None if parts is None else _STR_SEPARATOR.join(parts)


def build_reconciliation_document(
    *,
    run_id: str,
    county: str,
    cama_source_url: str,
    cama_source_fingerprint: str,
    fdor_source_url: str,
    fdor_snapshot_prefix: str,
    fdor_snapshot_token: str,
    fdor_assessment_year: int | None,
    snapshot_year: int,
    started_at: str,
    finished_at: str,
    overlap: Overlap,
    living_area: FieldComparison,
    year_built: FieldComparison,
    effective_year: FieldComparison,
    dor_code: FieldComparison,
    assessed_value: FieldComparison,
    just_value: JustValueBands,
    sales: SaleComparison,
    owner: OwnerComparison,
    null_results: NullResults,
) -> dict[str, Any]:
    """Assemble ``reconciliation.json``.

    The document reports every comparison alongside the baseline it is being held to, so
    a reader does not have to fetch the findings doc to know whether a number is normal.
    """
    return {
        "version": RECONCILIATION_VERSION,
        "runId": run_id,
        "county": county,
        "snapshotYear": snapshot_year,
        "startedAt": started_at,
        "finishedAt": finished_at,
        "sources": {
            "cama": {
                "url": cama_source_url,
                "fingerprint": cama_source_fingerprint,
                "cadence": "nightly",
                "role": "system of record",
            },
            "fdor": {
                "url": fdor_source_url,
                "snapshotPrefix": fdor_snapshot_prefix,
                "snapshotToken": fdor_snapshot_token,
                "assessmentYear": fdor_assessment_year,
                "cadence": "annual (published each August)",
                "role": "backfill and validator",
            },
        },
        "join": {
            # No dash stripping, no zero padding, no case folding. Both sides are 100%
            # 17-character uppercase alphanumeric with zero whitespace and zero case
            # variance, and ~43% of keys contain letters — a numeric cast would corrupt
            # them. The trim/upper in the join are documented no-ops.
            "key": "parcel_id",
            "rule": "upper(trim(cama.parcel_id)) = upper(trim(fdor.PARCEL_ID))",
            "keyLength": 17,
            "normalizationRequired": False,
        },
        "overlap": {
            "camaTotal": overlap.cama_total,
            "fdorTotal": overlap.fdor_total,
            "matched": overlap.matched,
            "camaOnly": overlap.cama_only,
            "fdorOnly": overlap.fdor_only,
            "matchedShareOfCama": ratio(overlap.matched, overlap.cama_total),
            "matchedShareOfFdor": ratio(overlap.matched, overlap.fdor_total),
            "baselines": dict(OVERLAP_BASELINES),
        },
        "fieldAgreement": {
            "total_living_area": {
                "comparable": living_area.comparable,
                "exact": living_area.exact,
                "rate": ratio(living_area.exact, living_area.comparable),
                "baseline": AGREEMENT_BASELINES["total_living_area"],
                "anomalies": living_area.beyond_tolerance,
                "anomalyRule": "differs by more than 10%",
                "verdict": "reconcile",
            },
            "dor_code": {
                "comparable": dor_code.comparable,
                "exact": dor_code.exact,
                "rate": ratio(dor_code.exact, dor_code.comparable),
                "baseline": AGREEMENT_BASELINES["dor_code"],
                "anomalies": dor_code.beyond_tolerance,
                "anomalyRule": "any mismatch on the 2-digit code",
                "verdict": "reconcile",
            },
            "year_built": {
                "comparable": year_built.comparable,
                "exact": year_built.exact,
                "rate": ratio(year_built.exact, year_built.comparable),
                "baseline": AGREEMENT_BASELINES["year_built"],
                "anomalies": year_built.beyond_tolerance,
                "anomalyRule": "differs by more than 1 year",
                "verdict": "reconcile",
            },
            "max_effective_year_blt": {
                "comparable": effective_year.comparable,
                "exact": effective_year.exact,
                "rate": ratio(effective_year.exact, effective_year.comparable),
                "baseline": AGREEMENT_BASELINES["max_effective_year_blt"],
                "anomalies": effective_year.beyond_tolerance,
                "anomalyRule": "differs by more than 1 year",
                "verdict": "reconcile, wider band",
            },
            "total_just_value": {
                "comparable": just_value.comparable,
                "exact": just_value.exact,
                "rate": ratio(just_value.exact, just_value.comparable),
                "baseline": AGREEMENT_BASELINES["total_just_value_exact"],
                "bands": {
                    "within1pct": ratio(just_value.within_1pct, just_value.comparable),
                    "within5pct": ratio(just_value.within_5pct, just_value.comparable),
                    "within10pct": ratio(just_value.within_10pct, just_value.comparable),
                    "within25pct": ratio(just_value.within_25pct, just_value.comparable),
                },
                "within25pctBaseline": AGREEMENT_BASELINES["total_just_value_within_25pct"],
                "anomalies": just_value.comparable - just_value.within_25pct,
                "anomalyRule": "differs by more than 25%",
                # The headline number for this field is the band, not the exact rate.
                # 8.26% exact is a comparison across assessment years, confirmed by
                # sampled rows where building attributes match exactly and only value
                # moves, and by nominal $100 parcels agreeing 92.67% because they are
                # never revalued.
                "verdict": "band only — annual revaluation, not error",
            },
            "assessed_value": {
                "comparable": assessed_value.comparable,
                "exact": assessed_value.exact,
                "rate": ratio(assessed_value.exact, assessed_value.comparable),
                "baseline": AGREEMENT_BASELINES["assessed_value"],
                # `AV_SD` is the school-district assessed value and CAMA's
                # `assessed_value` is not that concept. Reported so the mismatch is on
                # the record as a definition difference rather than rediscovered as a
                # defect; never alerted on.
                "verdict": "do not reconcile — different metric",
            },
            "owner_name": {
                "comparable": owner.name_comparable,
                "exact": owner.name_prefix_match,
                "rate": ratio(owner.name_prefix_match, owner.name_comparable),
                "baseline": AGREEMENT_BASELINES["owner_name_prefix"],
                "measure": "FDOR value is a prefix of the CAMA value (30-char truncation)",
                "verdict": "advisory only",
            },
        },
        "sales": {
            "gate": f"QUAL_CD1 IN {QUALIFIED_SALE_CODES}",
            "controlGate": f"QUAL_CD1 IN {UNQUALIFIED_SALE_CODES}",
            "qualified": {
                "comparable": sales.qualified_comparable,
                "yearExact": sales.qualified_year_exact,
                "yearRate": ratio(sales.qualified_year_exact, sales.qualified_comparable),
                "yearBaseline": AGREEMENT_BASELINES["qualified_sale_year"],
                "priceExact": sales.qualified_price_exact,
                "priceRate": ratio(sales.qualified_price_exact, sales.qualified_comparable),
                "priceBaseline": AGREEMENT_BASELINES["qualified_sale_price"],
                "verdict": "reconcile",
            },
            "unqualified": {
                "comparable": sales.unqualified_comparable,
                "yearExact": sales.unqualified_year_exact,
                "yearRate": ratio(sales.unqualified_year_exact, sales.unqualified_comparable),
                "yearBaseline": AGREEMENT_BASELINES["unqualified_sale_year"],
                # Quitclaims and related-party transfers, booked at $100. CAMA is correct
                # to hold the last market sale instead, so this rate is expected to stay
                # near zero — a rise means the gate stopped being applied.
                "verdict": "do not reconcile — non-market transfers",
            },
            "note": (
                "FDOR's NAL sale fields cover the assessment cycle only (SALE_YR1 is 2024 "
                "or 2025, and 160,275 of 179,107 parcels carry no sale), while CAMA's "
                "last_sale_date is a lifetime most-recent. Different temporal classes."
            ),
        },
        "owner": {
            "precedence": "cama",
            "stateBackfilledFromFdor": owner.state_backfilled,
            "zipBackfilledFromFdor": owner.zip_backfilled,
            "stateDisagreements": owner.state_disagreements,
            "zipDisagreements": owner.zip_disagreements,
            "note": (
                "FDOR is backfill-and-validator only. The CAMA mailing blob parses to a "
                "state on 99.50% of rows and FDOR rescues 0.28% of them, while the "
                "disagreements are bidirectional mailing churn against a year-old "
                "snapshot. A state mismatch is a change signal, not a correction."
            ),
        },
        "nullResults": {
            "coordinates": {
                "compared": null_results.coordinates_compared,
                "identicalAt6dp": null_results.coordinates_identical_6dp,
                "rate": ratio(
                    null_results.coordinates_identical_6dp, null_results.coordinates_compared
                ),
                "baseline": AGREEMENT_BASELINES["coordinates_identical_6dp"],
                "interpretation": (
                    "Not an independent check. Median centroid separation is 0.01 m and "
                    "the geometry shares lineage with the county GIS layer that produced "
                    "CAMA's lat/long. Agreement here corroborates nothing."
                ),
            },
            "sectionTownshipRange": {
                "compared": null_results.section_township_range_compared,
                "agree": null_results.section_township_range_agree,
                "rate": ratio(
                    null_results.section_township_range_agree,
                    null_results.section_township_range_compared,
                ),
                "baseline": AGREEMENT_BASELINES["section_township_range"],
                "interpretation": (
                    "Derived from characters 1-6 of the CAMA parcel id and validated "
                    "against FDOR's discrete columns. FDOR is the validator, not the "
                    "source — no second source is needed for this field."
                ),
            },
        },
        "precedence": dict(PRECEDENCE),
        # Expected anomaly volumes at the thresholds above, so a reader can tell a rule
        # that fired normally from one that fired on ten times its usual population.
        "anomalyBaselines": dict(ANOMALY_THRESHOLDS),
        "independence": (
            "Partially independent. Separate statutory submission, separate certification "
            "cycle, and separate lineage artifacts (OWN_NAME truncates at 30 characters "
            "where CAMA runs to 101). But the upstream author is the same office, so this "
            "is a time-lagged state-certified snapshot of the same appraiser's roll — it "
            "catches roll drift and parcel lifecycle change, not a systematic SCPA "
            "measurement error."
        ),
    }


def _drifted(measured: float, baseline: float, tolerance: float) -> bool:
    return abs(measured - baseline) > tolerance


def assert_reconciliation_matches_expected(
    document: Mapping[str, Any],
    *,
    agreement_tolerance: float = AGREEMENT_TOLERANCE,
) -> None:
    """Fail the run when a reconciliation figure moved away from its measured baseline.

    Every deviation is collected before raising rather than failing on the first one,
    because these figures fail in correlated groups — losing the qualification gate moves
    both sale rates, and a broken join moves every rate at once. Reporting one number
    would send the reader looking for a field-specific cause that is not there.

    A first run against a county with no baselines, or an FDOR snapshot that could not be
    read, produces no ``overlap`` section and is not checked: there is nothing to compare.
    """
    overlap = document.get("overlap")
    if not overlap:
        return

    deviations: list[str] = []

    for name, baseline_count in OVERLAP_BASELINES.items():
        measured_count = int(overlap.get(name, 0))
        tolerance = OVERLAP_TOLERANCE[name]
        allowed = baseline_count * tolerance
        if abs(measured_count - baseline_count) > allowed:
            deviations.append(
                f"{name}: {measured_count:,} against a baseline of {baseline_count:,} "
                f"(±{tolerance:.0%})"
            )

    for name, measured_rate in _measured_rates(document).items():
        baseline_rate = AGREEMENT_BASELINES[name]
        if _drifted(measured_rate, baseline_rate, agreement_tolerance):
            deviations.append(
                f"{name}: {measured_rate:.2%} against a baseline of {baseline_rate:.2%} "
                f"(±{agreement_tolerance:.0%})"
            )

    if deviations:
        raise ReconciliationDriftError(
            "reconciliation drifted from the measured baselines — "
            + "; ".join(deviations)
            + ". These figures were measured against live data on 2026-09-01 and are "
            "reproducible; a deviation this large is a broken join, a lost null "
            "conversion, or a dropped qualification gate, not a new truth."
        )


def _measured_rates(document: Mapping[str, Any]) -> dict[str, float]:
    """Pull every pinned rate out of a reconciliation document, keyed by its baseline."""
    fields: Mapping[str, Any] = document.get("fieldAgreement", {})
    sales: Mapping[str, Any] = document.get("sales", {})
    nulls: Mapping[str, Any] = document.get("nullResults", {})

    just_value: Mapping[str, Any] = fields.get("total_just_value", {})
    qualified: Mapping[str, Any] = sales.get("qualified", {})
    unqualified: Mapping[str, Any] = sales.get("unqualified", {})

    return {
        "total_living_area": float(fields.get("total_living_area", {}).get("rate", 0.0)),
        "dor_code": float(fields.get("dor_code", {}).get("rate", 0.0)),
        "year_built": float(fields.get("year_built", {}).get("rate", 0.0)),
        "max_effective_year_blt": float(fields.get("max_effective_year_blt", {}).get("rate", 0.0)),
        "owner_name_prefix": float(fields.get("owner_name", {}).get("rate", 0.0)),
        "assessed_value": float(fields.get("assessed_value", {}).get("rate", 0.0)),
        "total_just_value_exact": float(just_value.get("rate", 0.0)),
        "total_just_value_within_25pct": float(just_value.get("bands", {}).get("within25pct", 0.0)),
        "qualified_sale_year": float(qualified.get("yearRate", 0.0)),
        "qualified_sale_price": float(qualified.get("priceRate", 0.0)),
        "unqualified_sale_year": float(unqualified.get("yearRate", 0.0)),
        "coordinates_identical_6dp": float(nulls.get("coordinates", {}).get("rate", 0.0)),
        "section_township_range": float(nulls.get("sectionTownshipRange", {}).get("rate", 0.0)),
    }
