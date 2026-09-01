"""Input-validation tests: the header contract, the BOM, volume, and grain."""

from __future__ import annotations

import pytest

from oracle_pipeline.schema import (
    BOM,
    CAMA_TABLES,
    PARCEL_GRAIN,
    ROW_COUNT_BOUNDS,
    GrainError,
    SchemaDriftError,
    VolumeError,
    assert_non_empty,
    assert_parcel_grain,
    assert_row_count_within_bounds,
    normalize_header,
    strip_bom,
    validate_table_schema,
)


def test_every_table_has_bounds_and_a_declared_grain() -> None:
    """A new table must not be addable without also declaring how it is validated."""
    assert set(CAMA_TABLES) == set(ROW_COUNT_BOUNDS) == set(PARCEL_GRAIN)


def test_parcels_header_matches_the_profiled_extract() -> None:
    """59 columns, with Latitude and Longitude last — the 2026-08-31 layout."""
    columns = CAMA_TABLES["Parcels.csv"]
    assert len(columns) == 59
    assert columns[-2:] == ("Latitude", "Longitude")
    assert columns[1] == "Parcel"


def test_sales_qual_keeps_the_sources_misspelled_column() -> None:
    """`TaxDistict` is how the source spells it; correcting it here would be drift."""
    columns = CAMA_TABLES["SalesQual.csv"]
    assert "TaxDistict" in columns
    assert "TaxDistrict" in columns


def test_strip_bom_removes_only_a_leading_bom() -> None:
    assert strip_bom(f"{BOM}MasterId") == "MasterId"
    assert strip_bom("MasterId") == "MasterId"
    assert strip_bom(f"Master{BOM}Id") == f"Master{BOM}Id"


def test_normalize_header_strips_the_bom_and_whitespace() -> None:
    assert normalize_header([f"{BOM}MasterId", " Parcel ", "Latitude"]) == (
        "MasterId",
        "Parcel",
        "Latitude",
    )


def test_validate_accepts_the_real_bom_prefixed_header() -> None:
    """The BOM is present on all nine files, so the happy path includes it."""
    expected = CAMA_TABLES["Taxes.csv"]
    actual = [f"{BOM}{expected[0]}", *expected[1:]]
    assert validate_table_schema("Taxes.csv", actual) == expected


def test_validate_fails_loud_on_a_missing_column() -> None:
    expected = list(CAMA_TABLES["Parcels.csv"])
    expected.remove("Longitude")
    with pytest.raises(SchemaDriftError, match="missing=\\['Longitude'\\]"):
        validate_table_schema("Parcels.csv", expected)


def test_validate_fails_loud_on_an_added_column() -> None:
    """An added column means the county changed the layout — stop and look."""
    actual = [*CAMA_TABLES["Subdivision.csv"], "SolarPotential"]
    with pytest.raises(SchemaDriftError, match="unexpected=\\['SolarPotential'\\]"):
        validate_table_schema("Subdivision.csv", actual)


def test_validate_fails_loud_on_reordered_columns() -> None:
    """Same names, different order: a positional read would silently swap the values."""
    columns = list(CAMA_TABLES["ExtraFeature.csv"])
    columns[0], columns[1] = columns[1], columns[0]
    with pytest.raises(SchemaDriftError, match="column order changed"):
        validate_table_schema("ExtraFeature.csv", columns)


def test_validate_rejects_an_unknown_table() -> None:
    with pytest.raises(SchemaDriftError, match="not a known CAMA table"):
        validate_table_schema("Permits.csv", ["Parcel"])


@pytest.mark.parametrize("count", [0, -1])
def test_assert_non_empty_rejects_an_empty_extract(count: int) -> None:
    """A zero-row CSV is what a failed nightly rebuild upstream looks like."""
    with pytest.raises(VolumeError, match="source is empty"):
        assert_non_empty("Parcels.csv", count)


def test_row_count_bounds_admit_the_observed_counts() -> None:
    """The bands must not reject the extract they were derived from."""
    observed = {
        "Parcels.csv": 181_217,
        "AllSales.csv": 853_095,
        "buildings.csv": 172_382,
        "BuildingSummarys.csv": 161_980,
        "ExtraFeature.csv": 315_603,
        "MailingLabels.csv": 178_924,
        "SalesQual.csv": 157_166,
        "Subdivision.csv": 4_002,
        "Taxes.csv": 878_680,
    }
    for table, count in observed.items():
        assert_row_count_within_bounds(table, count)


def test_row_count_bounds_reject_a_truncated_extract() -> None:
    with pytest.raises(VolumeError, match="outside expected band"):
        assert_row_count_within_bounds("Parcels.csv", 4_000)


def test_row_count_bounds_reject_a_runaway_extract() -> None:
    with pytest.raises(VolumeError, match="outside expected band"):
        assert_row_count_within_bounds("Parcels.csv", 900_000)


def test_parcel_grain_accepts_one_row_per_parcel() -> None:
    assert_parcel_grain("MailingLabels.csv", 178_924, 178_924)


def test_parcel_grain_rejects_a_fan_out() -> None:
    """This is the assertion standing between the spine and a cartesian blow-up."""
    with pytest.raises(GrainError, match="would fan out"):
        assert_parcel_grain("AllSales.csv", 853_095, 176_166)


def test_child_tables_are_declared_not_parcel_grain() -> None:
    """The four many-per-parcel tables must be reduced before they touch the spine."""
    assert PARCEL_GRAIN["AllSales.csv"] is False
    assert PARCEL_GRAIN["buildings.csv"] is False
    assert PARCEL_GRAIN["ExtraFeature.csv"] is False
    assert PARCEL_GRAIN["Taxes.csv"] is False
    # Not parcel-grain in any sense: it joins on subdivision name, not parcel id.
    assert PARCEL_GRAIN["Subdivision.csv"] is False
