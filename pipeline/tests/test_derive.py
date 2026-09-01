"""Derivation tests.

The cases are written against the shapes actually present in the 2026-08-31 extract —
leading-zero parcel ids, the clean `Improved`/`Vacant` binary, `"S1 - SANFORD"` tax
districts, `"LONGWOOD, FL 32779-5041"` mailing labels — rather than invented ones.
"""

from __future__ import annotations

import pytest

from oracle_pipeline.derive import (
    RENOVATION_MAJOR,
    RENOVATION_MODERATE,
    RENOVATION_NONE,
    UNINCORPORATED,
    effective_roof_year,
    is_improved,
    jurisdiction,
    normalize_subdivision_name,
    owner_out_of_area,
    parcel_id_text,
    parse_city_state_zip,
    parse_year,
    renovation_signal,
    roof_age,
    tax_district_code,
    years_since_sale,
)

SNAPSHOT_YEAR = 2026


# --- parcel identity ------------------------------------------------------------------


def test_parcel_id_keeps_leading_zeros() -> None:
    """38,308 of the county's 181,217 parcel ids start with a zero."""
    assert parcel_id_text("01202930000100000") == "01202930000100000"


def test_parcel_id_preserves_alphanumeric_ids() -> None:
    """Condominium and split parcels embed letters: `012029300001C0000`."""
    assert parcel_id_text(" 012029300001C0000 ") == "012029300001C0000"


@pytest.mark.parametrize("value", [None, "", "   "])
def test_parcel_id_treats_blanks_as_missing(value: str | None) -> None:
    assert parcel_id_text(value) is None


# --- improved / vacant ----------------------------------------------------------------


def test_improved_flag_matches_the_sources_binary() -> None:
    assert is_improved("Improved") is True
    assert is_improved("Vacant") is False
    assert is_improved(None) is False
    assert is_improved("") is False


def test_improved_flag_is_case_sensitive_to_the_source_spelling() -> None:
    """The extract holds exactly `Improved` and `Vacant`; anything else is drift."""
    assert is_improved("IMPROVED") is False


# --- years ----------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("1998", 1998),
        (2004, 2004),
        ("2004.0", 2004),
        ("", None),
        (None, None),
        ("not a year", None),
        ("1799", None),  # before the plausibility floor
        ("2027", None),  # after the snapshot
    ],
)
def test_parse_year(raw: str | int | None, expected: int | None) -> None:
    assert parse_year(raw, snapshot_year=SNAPSHOT_YEAR) == expected


def test_effective_roof_year_prefers_the_renovation_adjusted_year() -> None:
    assert effective_roof_year("1972", "1972", "1998", snapshot_year=SNAPSHOT_YEAR) == 1998


def test_effective_roof_year_falls_back_through_the_chain() -> None:
    assert effective_roof_year("1972", "1985", None, snapshot_year=SNAPSHOT_YEAR) == 1985
    assert effective_roof_year("1972", None, None, snapshot_year=SNAPSHOT_YEAR) == 1972
    assert effective_roof_year(None, None, None, snapshot_year=SNAPSHOT_YEAR) is None


def test_effective_roof_year_never_ages_off_a_stale_effective_year() -> None:
    """A newer original build must win over an older effective year, not lose to it."""
    assert effective_roof_year("2010", None, "1998", snapshot_year=SNAPSHOT_YEAR) == 2010


def test_roof_age_uses_the_effective_year() -> None:
    assert roof_age("Improved", "1972", "1972", "1998", snapshot_year=SNAPSHOT_YEAR) == 28


def test_roof_age_is_none_for_vacant_land() -> None:
    """19,236 parcels are vacant. A roof age of 54 on bare dirt is worse than a null."""
    assert roof_age("Vacant", "1972", None, None, snapshot_year=SNAPSHOT_YEAR) is None


def test_roof_age_is_none_when_every_year_is_missing() -> None:
    assert roof_age("Improved", "", "", "", snapshot_year=SNAPSHOT_YEAR) is None


def test_roof_age_is_never_negative() -> None:
    """A future year is rejected by the plausibility guard rather than producing -4."""
    assert roof_age("Improved", "2030", None, None, snapshot_year=SNAPSHOT_YEAR) is None


# --- sale recency ---------------------------------------------------------------------


def test_years_since_sale_reads_the_year_out_of_the_date() -> None:
    assert years_since_sale("2019-04-15", None, snapshot_year=SNAPSHOT_YEAR) == 7


def test_years_since_sale_handles_us_formatted_dates() -> None:
    assert years_since_sale("04/15/2019", None, snapshot_year=SNAPSHOT_YEAR) == 7


def test_years_since_sale_falls_back_to_the_year_column() -> None:
    assert years_since_sale("", "2011", snapshot_year=SNAPSHOT_YEAR) == 15


def test_years_since_sale_is_none_for_a_never_sold_parcel() -> None:
    """Null, not a large number, so downstream percentiles are not polluted."""
    assert years_since_sale(None, None, snapshot_year=SNAPSHOT_YEAR) is None


# --- renovation -----------------------------------------------------------------------


def test_renovation_signal_bands() -> None:
    assert (
        renovation_signal("Improved", "1972", "1972", snapshot_year=SNAPSHOT_YEAR)
        == RENOVATION_NONE
    )
    assert (
        renovation_signal("Improved", "1972", "1977", snapshot_year=SNAPSHOT_YEAR)
        == RENOVATION_MODERATE
    )
    assert (
        renovation_signal("Improved", "1972", "1998", snapshot_year=SNAPSHOT_YEAR)
        == RENOVATION_MAJOR
    )


def test_renovation_signal_treats_a_negative_uplift_as_none() -> None:
    assert (
        renovation_signal("Improved", "1998", "1972", snapshot_year=SNAPSHOT_YEAR)
        == RENOVATION_NONE
    )


def test_renovation_signal_is_none_for_vacant_land() -> None:
    assert renovation_signal("Vacant", "1972", "1998", snapshot_year=SNAPSHOT_YEAR) is None


# --- jurisdiction ---------------------------------------------------------------------


@pytest.mark.parametrize(
    ("raw", "code"),
    [
        ("01 - COUNTY-TX DIST 1", "01"),
        ("S1 - SANFORD", "S1"),
        ("V5", "V5"),
        ("", None),
        (None, None),
    ],
)
def test_tax_district_code(raw: str | None, code: str | None) -> None:
    """`Parcels.csv` packs code and description together; `Taxes.csv` splits them."""
    assert tax_district_code(raw) == code


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("S1 - SANFORD", "Sanford"),
        ("A1 - ALTAMONTE", "Altamonte Springs"),
        ("W1 - WINTER SPRINGS", "Winter Springs"),
        ("V1 - OVIEDO", "Oviedo"),
        ("C1 - CASSELBERRY", "Casselberry"),
        ("M1 - LAKE MARY", "Lake Mary"),
        ("L1 - LONGWOOD", "Longwood"),
    ],
)
def test_jurisdiction_maps_every_municipal_district(raw: str, expected: str) -> None:
    assert jurisdiction(raw) == expected


@pytest.mark.parametrize(
    "raw",
    ["01 - COUNTY-TX DIST 1", "02 - COUNTY-DOVERA", "G1 - AGRICULTURAL", "", None],
)
def test_jurisdiction_maps_county_districts_to_unincorporated(raw: str | None) -> None:
    assert jurisdiction(raw) == UNINCORPORATED


@pytest.mark.parametrize(
    "raw",
    ["V2 - OVIEDO-DOVERA CDD", "V5 - OVIEDO-COMMUNITY REDVDST"],
)
def test_jurisdiction_folds_cdd_and_redevelopment_variants_into_their_city(raw: str) -> None:
    """Oviedo issues three district codes; all three are still Oviedo."""
    assert jurisdiction(raw) == "Oviedo"


def test_jurisdiction_folds_the_winter_springs_cdd() -> None:
    assert jurisdiction("W2 - WINTER SPRINGS-DOVERA CDD") == "Winter Springs"


# --- owner location -------------------------------------------------------------------


def test_parse_city_state_zip_splits_a_standard_label() -> None:
    assert parse_city_state_zip("LONGWOOD, FL 32779-5041") == ("LONGWOOD", "FL", "32779")


def test_parse_city_state_zip_handles_a_five_digit_zip() -> None:
    assert parse_city_state_zip("ORLANDO, FL 32803") == ("ORLANDO", "FL", "32803")


def test_parse_city_state_zip_handles_a_multiword_city() -> None:
    assert parse_city_state_zip("LAKE MARY, FL 32746-5061") == ("LAKE MARY", "FL", "32746")


@pytest.mark.parametrize("value", [None, "", "LONDON W1A 1AA UNITED KINGDOM"])
def test_parse_city_state_zip_returns_nulls_when_it_cannot_parse(value: str | None) -> None:
    """510 of 178,924 labels are foreign addresses with no US state."""
    assert parse_city_state_zip(value) == (None, None, None)


def test_owner_out_of_area_is_false_for_a_county_zip() -> None:
    assert owner_out_of_area("LONGWOOD, FL 32779-5041") is False


def test_owner_out_of_area_is_true_for_in_state_but_outside_the_county() -> None:
    """Orlando is Orange County: an absentee owner one county over still counts."""
    assert owner_out_of_area("ORLANDO, FL 32803-4602") is True


def test_owner_out_of_area_is_true_for_out_of_state() -> None:
    assert owner_out_of_area("GERMANTOWN, TN 38138-0600") is True
    assert owner_out_of_area("SCOTTSDALE, AZ 85261") is True


def test_owner_out_of_area_is_none_when_the_label_does_not_parse() -> None:
    """Unknown, not local — an unparseable address must never read as an owner-occupier."""
    assert owner_out_of_area("LONDON W1A 1AA UNITED KINGDOM") is None
    assert owner_out_of_area(None) is None


# --- subdivision join key -------------------------------------------------------------


def test_normalize_subdivision_name_bridges_the_two_sides() -> None:
    """`Parcels.Subdivision` is title case with punctuation; `SubName` is uppercase."""
    assert normalize_subdivision_name("125 & 131 Condominium") == "125 131 CONDOMINIUM"
    assert normalize_subdivision_name("WEISERS SUBD") == "WEISERS SUBD"


def test_normalize_subdivision_name_collapses_repeated_separators() -> None:
    assert normalize_subdivision_name("OAK  -  HILL,  PH. 2") == "OAK HILL PH 2"


@pytest.mark.parametrize("value", [None, "", "   ", "&&&"])
def test_normalize_subdivision_name_returns_none_for_empty_keys(value: str | None) -> None:
    """A blank key must not join every unplatted parcel to one arbitrary subdivision."""
    assert normalize_subdivision_name(value) is None
