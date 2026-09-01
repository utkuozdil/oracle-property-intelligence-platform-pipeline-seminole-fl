"""Tests for the FDOR reconciliation contract.

The interesting assertions here are not that the arithmetic works. They are that the four
comparisons which were measured *wrong* the first time stay measured right: land-use codes
truncated to two digits, sales gated on ``QUAL_CD1`` against a control population that is
enumerated rather than complemented, owner names normalised before the prefix test, and
FDOR's section/township/range normalised before it is compared to the parcel id.

Each of those four has a wrong version that produces a plausible-looking number rather
than an error, which is why every one of them is pinned to the figure it was measured at.
"""

from __future__ import annotations

from typing import Any

import pytest

from oracle_pipeline.reconcile import (
    AGREEMENT_BASELINES,
    ANOMALY_THRESHOLDS,
    OVERLAP_BASELINES,
    PRECEDENCE,
    QUALIFIED_SALE_CODES,
    UNQUALIFIED_SALE_CODES,
    ZERO_IS_NULL_FIELDS,
    FieldComparison,
    JustValueBands,
    NullResults,
    Overlap,
    OwnerComparison,
    ReconciliationDriftError,
    SaleComparison,
    assert_reconciliation_matches_expected,
    build_reconciliation_document,
    cama_dor_code,
    fdor_dor_code,
    fdor_section_township_range,
    fdor_section_township_range_key,
    owner_name_key,
    ratio,
    section_township_range,
    section_township_range_key,
)


class TestDorCode:
    @pytest.mark.parametrize(
        ("display", "expected"),
        [
            ("01 - SINGLE FAMILY", 1),
            ("80 - VACANT GOVERNMENTAL", 80),
            ("00 - VACANT RESIDENTIAL", 0),
        ],
    )
    def test_reads_the_leading_two_digit_code(self, display: str, expected: int) -> None:
        assert cama_dor_code(display) == expected

    def test_truncates_scpa_four_digit_sub_codes(self) -> None:
        """The 78.32%-vs-98.88% decision, pinned.

        CAMA's 4-digit values are sub-classifications FDOR does not publish, so comparing
        the full numeric prefix scores 78.32% where truncating to two digits scores
        98.88%. Both parse; only one is the right comparison.
        """
        assert cama_dor_code("0130 - SINGLE FAMILY WATERFRONT") == 1
        assert cama_dor_code("0830 - MULTI-FAMILY") == 8

    @pytest.mark.parametrize("display", [None, "", "SINGLE FAMILY", "   "])
    def test_returns_none_when_there_is_no_numeric_prefix(self, display: str | None) -> None:
        assert cama_dor_code(display) is None

    @pytest.mark.parametrize(
        ("code", "expected"),
        [("001", 1), ("080", 80), ("000", 0), ("  001 ", 1)],
    )
    def test_parses_fdor_zero_padded_codes(self, code: str, expected: int) -> None:
        assert fdor_dor_code(code) == expected

    @pytest.mark.parametrize("code", [None, " ", "", "ABC"])
    def test_fdor_blank_and_non_numeric_are_none(self, code: str | None) -> None:
        assert fdor_dor_code(code) is None

    def test_the_two_sides_agree_on_a_real_pair(self) -> None:
        assert cama_dor_code("01 - SINGLE FAMILY") == fdor_dor_code("001")


class TestSectionTownshipRange:
    @pytest.mark.parametrize(
        ("parcel_id", "expected"),
        [
            ("1821295020D000180", ("18", "21", "29")),
            ("0921305BP0A000010", ("09", "21", "30")),
            ("36193051302000000", ("36", "19", "30")),
            ("2121325QM00000150", ("21", "21", "32")),
        ],
    )
    def test_decodes_the_self_describing_key(
        self, parcel_id: str, expected: tuple[str, str, str]
    ) -> None:
        assert section_township_range(parcel_id) == expected

    @pytest.mark.parametrize("parcel_id", [None, "", "1821", "ABCDEF0000000000"])
    def test_returns_none_when_the_prefix_is_not_numeric(self, parcel_id: str | None) -> None:
        assert section_township_range(parcel_id) is None

    def test_normalises_fdor_padding_and_direction_suffixes(self) -> None:
        """FDOR writes ``SEC='9'`` unpadded and ``TWN='21S'`` with a direction letter.

        Both are formatting differences against the fixed-width parcel id, and treating
        either as a disagreement would drop this from 99.9995% to nonsense.
        """
        assert fdor_section_township_range("9", "21S", "30E") == ("09", "21", "30")
        assert fdor_section_township_range("18", "21S", "29E") == ("18", "21", "29")

    def test_the_two_representations_match_on_a_real_record(self) -> None:
        parcel_id = "0921305BP0A000010"
        assert section_township_range(parcel_id) == fdor_section_township_range("9", "21S", "30E")

    def test_the_one_known_bad_record_normalises_to_none(self) -> None:
        """One of 179,107 rows carries ``TWN='00'``, ``RNG='00'`` and a blank ``SEC``."""
        assert fdor_section_township_range(" ", "00", "00") is None

    def test_the_flattened_keys_are_comparable_as_scalars(self) -> None:
        assert section_township_range_key("1821295020D000180") == "18|21|29"
        assert fdor_section_township_range_key("18", "21S", "29E") == "18|21|29"
        assert section_township_range_key(None) is None
        assert fdor_section_township_range_key(None, None, None) is None


class TestOwnerNameKey:
    def test_strips_punctuation_and_spacing(self) -> None:
        assert owner_name_key("SMITH, JOHN A & MARY-JO") == "SMITHJOHNAMARYJO"

    def test_is_case_insensitive(self) -> None:
        assert owner_name_key("smith john") == owner_name_key("SMITH JOHN")

    def test_the_fdor_value_prefixes_the_cama_value_through_the_truncation(self) -> None:
        """The measure that scores 90.81%, on the shape the truncation actually takes.

        ``OWN_NAME`` is cut at 30 raw characters, so the FDOR value is a prefix of the
        CAMA value only once both sides drop punctuation — the cut lands mid-token and the
        two exports space and punctuate differently either side of it.
        """
        cama = owner_name_key("WESTMINSTER RETIREMENT COMMUNITIES OF FLORIDA INC")
        fdor = owner_name_key("WESTMINSTER RETIREMENT COMMU")
        assert cama is not None and fdor is not None
        assert cama.startswith(fdor)
        # A prefix, not a match — which is the whole reason equality tops out in the 60s.
        assert cama != fdor

    @pytest.mark.parametrize("value", [None, "", "   ", ",,, - &"])
    def test_a_value_with_no_alphanumeric_content_is_none(self, value: str | None) -> None:
        """So it lands outside the comparable population instead of matching everything.

        An empty key is a prefix of every string, which would silently inflate the rate.
        """
        assert owner_name_key(value) is None


class TestRatio:
    def test_reports_an_empty_denominator_as_zero(self) -> None:
        assert ratio(0, 0) == 0.0

    def test_computes_the_agreement_rate(self) -> None:
        assert ratio(151_080, 152_321) == pytest.approx(0.9919, abs=1e-4)


class TestContract:
    def test_the_sale_gate_is_the_two_qualified_codes(self) -> None:
        assert QUALIFIED_SALE_CODES == ("01", "02")

    def test_the_unqualified_control_is_enumerated_not_complemented(self) -> None:
        """The 1.97% control was measured on 11/14/30, so it has to be measured on those.

        Taking the complement of the qualified codes instead is the mistake that scored
        5.61%: the sparse remaining codes behave like market sales and dilute the control
        until it no longer demonstrates that the gate is applied.
        """
        assert UNQUALIFIED_SALE_CODES == ("11", "14", "30")
        assert not set(UNQUALIFIED_SALE_CODES) & set(QUALIFIED_SALE_CODES)

    def test_every_field_the_findings_doc_flags_is_zero_to_null_converted(self) -> None:
        for field in ("ACT_YR_BLT", "EFF_YR_BLT", "TOT_LVG_AR", "SALE_PRC1", "SALE_YR1"):
            assert field in ZERO_IS_NULL_FIELDS

    def test_just_value_is_not_zero_to_null_converted(self) -> None:
        """``JV`` is compared on all 178,863 matched rows, including nominal $100 parcels.

        Nulling zeros here would drop the 8,897 nominal parcels that agree 92.67% and
        distort the band distribution the field is actually judged on.
        """
        assert "JV" not in ZERO_IS_NULL_FIELDS

    def test_cama_wins_on_owner_location(self) -> None:
        """The one precedence decision that reverses the original proposal.

        FDOR is a year-old snapshot; the 2,322 state disagreements are bidirectional
        mailing churn and it rescues only 495 rows CAMA cannot parse.
        """
        assert PRECEDENCE["owner_state"] == "cama"
        assert PRECEDENCE["owner_zip"] == "cama"
        assert PRECEDENCE["owner_city"] == "cama"

    def test_section_township_range_is_derived_rather_than_sourced(self) -> None:
        assert PRECEDENCE["section_township_range"] == "derived-from-parcel-id"

    def test_the_overlap_baselines_are_the_measured_counts(self) -> None:
        assert OVERLAP_BASELINES == {"matched": 178_863, "camaOnly": 2_355, "fdorOnly": 244}


def _measured_document() -> dict[str, Any]:
    """A document carrying exactly the figures measured on 2026-09-01."""
    return build_reconciliation_document(
        run_id="run-test",
        county="Seminole County, FL",
        cama_source_url="https://files.scpafl.org/data/cama/SeminoleCounty.zip",
        cama_source_fingerprint="abc123",
        fdor_source_url="https://example.invalid/fdor",
        fdor_snapshot_prefix="raw/fdor/run-test/",
        fdor_snapshot_token="edit-1780974574367-n179107",
        fdor_assessment_year=2025,
        snapshot_year=2026,
        started_at="2026-09-01T00:00:00+00:00",
        finished_at="2026-09-01T00:10:00+00:00",
        overlap=Overlap(
            cama_total=181_218,
            fdor_total=179_107,
            matched=178_863,
            cama_only=2_355,
            fdor_only=244,
        ),
        living_area=FieldComparison(comparable=152_321, exact=151_080, beyond_tolerance=544),
        year_built=FieldComparison(comparable=159_270, exact=156_792, beyond_tolerance=2_326),
        effective_year=FieldComparison(comparable=159_270, exact=152_786, beyond_tolerance=6_276),
        dor_code=FieldComparison(comparable=178_863, exact=176_862, beyond_tolerance=2_001),
        assessed_value=FieldComparison(comparable=178_863, exact=12_403),
        just_value=JustValueBands(
            comparable=178_863,
            exact=14_771,
            within_1pct=79_117,
            within_5pct=129_158,
            within_10pct=154_545,
            within_25pct=172_840,
        ),
        sales=SaleComparison(
            qualified_comparable=9_215,
            qualified_year_exact=8_698,
            qualified_price_exact=7_867,
            unqualified_comparable=7_652,
            unqualified_year_exact=151,
        ),
        owner=OwnerComparison(
            name_comparable=178_826,
            name_prefix_match=162_292,
            state_backfilled=495,
            zip_backfilled=101,
            state_disagreements=2_322,
            zip_disagreements=10_223,
        ),
        null_results=NullResults(
            coordinates_compared=178_863,
            coordinates_identical_6dp=159_996,
            section_township_range_compared=179_107,
            section_township_range_agree=179_106,
        ),
    )


class TestDocument:
    def test_reproduces_every_measured_rate(self) -> None:
        document = _measured_document()
        fields = document["fieldAgreement"]
        assert isinstance(fields, dict)

        assert fields["total_living_area"]["rate"] == pytest.approx(0.9919, abs=1e-4)
        assert fields["dor_code"]["rate"] == pytest.approx(0.9888, abs=1e-4)
        assert fields["year_built"]["rate"] == pytest.approx(0.9844, abs=1e-4)
        assert fields["total_just_value"]["rate"] == pytest.approx(0.0826, abs=1e-4)
        assert fields["total_just_value"]["bands"]["within25pct"] == pytest.approx(0.9663, abs=1e-4)

    def test_reports_both_sides_of_the_sale_gate(self) -> None:
        sales = _measured_document()["sales"]
        assert isinstance(sales, dict)
        assert sales["qualified"]["yearRate"] == pytest.approx(0.9439, abs=1e-4)
        assert sales["qualified"]["priceRate"] == pytest.approx(0.8537, abs=1e-4)
        assert sales["unqualified"]["yearRate"] == pytest.approx(0.0197, abs=1e-4)

    def test_records_coordinates_as_a_null_result(self) -> None:
        nulls = _measured_document()["nullResults"]
        assert isinstance(nulls, dict)
        assert nulls["coordinates"]["rate"] == pytest.approx(0.8945, abs=1e-4)
        assert "not an independent check" in nulls["coordinates"]["interpretation"].lower()

    def test_states_the_join_needs_no_normalization(self) -> None:
        join = _measured_document()["join"]
        assert isinstance(join, dict)
        assert join["keyLength"] == 17
        assert join["normalizationRequired"] is False

    def test_carries_the_anomaly_baselines(self) -> None:
        assert _measured_document()["anomalyBaselines"] == dict(ANOMALY_THRESHOLDS)


class TestDriftAssertion:
    def test_the_measured_figures_pass(self) -> None:
        assert_reconciliation_matches_expected(_measured_document())

    def test_a_document_with_no_overlap_is_not_checked(self) -> None:
        """No FDOR snapshot means nothing to compare, which is not a failure."""
        assert_reconciliation_matches_expected({"version": 1, "runId": "run-test"})

    def test_a_collapsed_join_fails(self) -> None:
        document = _measured_document()
        document["overlap"]["matched"] = 90_000
        with pytest.raises(ReconciliationDriftError, match="matched"):
            assert_reconciliation_matches_expected(document)

    def test_a_lost_qualification_gate_fails(self) -> None:
        """Ungated, sale-year agreement is 51.8% against a 94.39% baseline.

        This is the drift check earning its place: nothing else about the run changes.
        """
        document = _measured_document()
        document["sales"]["qualified"]["yearRate"] = 0.518
        with pytest.raises(ReconciliationDriftError, match="qualified_sale_year"):
            assert_reconciliation_matches_expected(document)

    def test_unqualified_sales_climbing_to_the_qualified_rate_fails(self) -> None:
        document = _measured_document()
        document["sales"]["unqualified"]["yearRate"] = 0.94
        with pytest.raises(ReconciliationDriftError, match="unqualified_sale_year"):
            assert_reconciliation_matches_expected(document)

    def test_an_untruncated_land_use_comparison_fails(self) -> None:
        """78.32% is what comparing CAMA's full numeric prefix scores."""
        document = _measured_document()
        document["fieldAgreement"]["dor_code"]["rate"] = 0.7832
        with pytest.raises(ReconciliationDriftError, match="dor_code"):
            assert_reconciliation_matches_expected(document)

    def test_the_just_value_exact_rate_is_pinned_low_not_high(self) -> None:
        """8.26% exact is correct. A sudden 96% would mean the comparison changed."""
        document = _measured_document()
        document["fieldAgreement"]["total_just_value"]["rate"] = 0.96
        with pytest.raises(ReconciliationDriftError, match="total_just_value_exact"):
            assert_reconciliation_matches_expected(document)

    def test_cama_only_growth_over_the_year_does_not_fail(self) -> None:
        """FDOR is fixed and CAMA adds parcels nightly, so this set climbs all year."""
        document = _measured_document()
        document["overlap"]["camaOnly"] = 3_400
        assert_reconciliation_matches_expected(document)

    def test_every_deviation_is_reported_at_once(self) -> None:
        document = _measured_document()
        document["fieldAgreement"]["year_built"]["rate"] = 0.10
        document["fieldAgreement"]["total_living_area"]["rate"] = 0.10
        with pytest.raises(ReconciliationDriftError) as raised:
            assert_reconciliation_matches_expected(document)
        assert "year_built" in str(raised.value)
        assert "total_living_area" in str(raised.value)

    def test_every_baseline_has_a_measured_rate_behind_it(self) -> None:
        """Guards against a baseline being added without being wired into the check."""
        from oracle_pipeline.reconcile import _measured_rates

        assert set(_measured_rates(_measured_document())) == set(AGREEMENT_BASELINES)
