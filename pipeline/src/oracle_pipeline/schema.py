"""The input contract for the nine Seminole County CAMA tables.

This module is the ``principle-input-validation`` implementation for the Glue tier. The
rule's language table maps ``Python (Glue/PySpark)`` to "schema checks on DataFrame
columns", so validation here is column-level rather than Pydantic row models — parsing
181,217 rows through a row model would defeat the point of using Spark at all.

Every column list below was read off the real 2026-08-31 extract, not from a data
dictionary. Two traps are encoded here because both were observed in that extract:

1. The header carries a UTF-8 BOM (``\\ufeff"MasterId"``). Left in place it silently
   renames the first column and every join on it misses.
2. Quoted fields contain embedded commas (legal descriptions, mailing addresses), so
   the reader must be quote-aware. That is enforced at the Spark read options, but
   :func:`validate_table_schema` is what catches the resulting damage if it is not.

Nothing in this module imports Spark, so all of it is unit-testable locally.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from typing import Final

BOM: Final = "\ufeff"

#: Join key present on every table. Always TEXT — 38,308 of the 181,217 Seminole parcel
#: ids begin with a zero, so any numeric inference silently corrupts a fifth of the county.
PARCEL_KEY: Final = "Parcel"

PARCELS_COLUMNS: Final[tuple[str, ...]] = (
    "MasterId",
    "Parcel",
    "ParcelFormat",
    "OwnerName",
    "PrimaryAddress",
    "MailingAddress",
    "PrimaryPropertyType",
    "VacantImproved",
    "LegalDescription",
    "Subdivision",
    "FacilityName",
    "TaxDistrict",
    "DORCode",
    "Zoning",
    "FutureLandUse",
    "HasHomestead",
    "BuildingCount",
    "YearLastBldgBuilt",
    "YearBuilt",
    "MaxEffectiveYearBlt",
    "MinEffectiveYearBlt",
    "LastSaleDate",
    "LastSaleYear",
    "TotalJustValue",
    "AppraisedBuildingValue",
    "AppraisedExtraFeatureValue",
    "AppraisedLandValue",
    "AdjustedAgricultureValue",
    "AdjustedAgricultureFlag",
    "IncomeValue",
    "TotalNewConstruction",
    "AssessedValue",
    "TaxableValue",
    "TotalBaseAdjustedValue",
    "TotalBaseReplacementValue",
    "JustTotalAppraisedPct",
    "BuildingTotalAppraisedPct",
    "LandTotalAppraisedPct",
    "ExftTotalAppraisedPct",
    "AssesedTotalAppraisedPct",
    "DemolitionFlag",
    "MarketArea",
    "MarketAreaTitle",
    "Neighborhood",
    "NeighborhoodFactor",
    "TotalBaseArea",
    "TotalGrossArea",
    "TotalLivingArea",
    "TotalBedrooms",
    "TotalBathrooms",
    "MinBaseFloors",
    "MaxBaseFloors",
    "MaxBuildingHeight",
    "Fireplace",
    "Pool",
    "SUM_GISAcres",
    "SUM_LegalAcres",
    "Latitude",
    "Longitude",
)

ALL_SALES_COLUMNS: Final[tuple[str, ...]] = (
    "MasterId",
    "SaleKeyId",
    "SaleId",
    "Parcel",
    "ParcelFormat",
    "PlatBook",
    "PlatPage",
    "SaleCode",
    "DeedType",
    "DeedDescription",
    "SaleQual",
    "ProcessCode",
    "SaleDate",
    "SaleYear",
    "SaleAmt",
    "VacImp",
    "QualificationCode",
    "QualificationDescription",
    "Notes",
    "TaxDistrict",
)

BUILDINGS_COLUMNS: Final[tuple[str, ...]] = (
    "BldgId",
    "MasterId",
    "Parcel",
    "ParcelFormat",
    "PrimaryAddress",
    "MailingAddress",
    "BuildingNum",
    "BuildingClassification",
    "BuildingType",
    "Dor",
    "YearBuilt",
    "ExteriorWallType",
    "AdjustedValue",
    "ReplacementValue",
    "BaseRate",
    "BaseFloors",
    "BuildingHeight",
    "BaseArea",
    "GrossArea",
    "LivingArea",
    "Bedrooms",
    "Bathrooms",
    "Fireplace",
    "Pool",
    "TaxDistrict",
)

BUILDING_SUMMARYS_COLUMNS: Final[tuple[str, ...]] = (
    "MasterId",
    "Parcel",
    "ParcelFormat",
    "BuildingCount",
    "MaxYearBlt",
    "MinYearBlt",
    "TotalBaseAdjVal",
    "TotalBaseReplAmt",
    "TotalBaseArea",
    "TotalGrossArea",
    "TotalLivingArea",
    "TotalBedrooms",
    "TotalBathrooms",
    "MinBaseFloors",
    "MaxBaseFloors",
    "MaxBuildingHeight",
    "HasFireplace",
    "HasPool",
    "TaxDistrict",
)

EXTRA_FEATURE_COLUMNS: Final[tuple[str, ...]] = (
    "MasterId",
    "Parcel",
    "Description",
    "NumUnits",
    "AppraisedValue",
    "ReplaceAmount",
    "YearBuilt",
    "LineNo",
    "TaxDistrict",
)

MAILING_LABELS_COLUMNS: Final[tuple[str, ...]] = (
    "MasterId",
    "Parcel",
    "ParcelFormat",
    "Subdivision",
    "PropertyType",
    "OwnerName",
    "Address1",
    "Address2",
    "CityStateZip",
    "TaxDistrict",
)

SALES_QUAL_COLUMNS: Final[tuple[str, ...]] = (
    "MasterId",
    "Parcel",
    "ParcelFormat",
    "PrimaryAddress",
    "MailingAddress",
    "Subdivision",
    "CurrentOwnerName",
    "FacilityName",
    "PrimaryPropertyType",
    "VacantImproved",
    "LegalDescription",
    "OraBook",
    "OraPage",
    # Spelled without the `r` in the source extract. Corrected here would be drift.
    "TaxDistict",
    "DORCode",
    "SaleDate",
    "SaleYear",
    "SaleAmount",
    "SaleAmountPerLivingSqft",
    "SaleAmountPerBaseSqft",
    "CurrentLivingArea",
    "CurrentGrossArea",
    "CurrentBaseArea",
    "CurrentBaseFloors",
    "CurrentBedrooms",
    "CurrentBathrooms",
    "CurrentHasFireplace",
    "CurrentHasPool",
    "CurrentBldgCt",
    "CurrentHasBuilding",
    "CurrentAssessedVal",
    "CurrentTotalJustVal",
    "CurrentApprBldgVal",
    "CurrentApprExtraFeatureVal",
    "CurrentAppraisedLandVal",
    "CurrentAdjustedAgricultureVal",
    "CurrentAdjustedAgFlag",
    "CurrentIncomeVal",
    "CurrentTotalNewConstruction",
    "CurrentTaxableVal",
    "TaxDistrict",
)

SUBDIVISION_COLUMNS: Final[tuple[str, ...]] = (
    "SubId",
    "SubName",
    "TaxDistrict",
    "TaxDistrictDescription",
    "PlatAcreage",
    "RecordRefer",
    "Parcel",
)

TAXES_COLUMNS: Final[tuple[str, ...]] = (
    "MasterId",
    "TaxDistrict",
    "TaxDistrictDescription",
    "Parcel",
    "MillCode",
    "MillageDescription",
    "AssessedValue",
    "ExemptValue",
    "TaxableValue",
    "Millage",
    "Taxes",
    "SortKey",
)

#: File name in the source ZIP -> its exact expected header, in order.
CAMA_TABLES: Final[Mapping[str, tuple[str, ...]]] = {
    "Parcels.csv": PARCELS_COLUMNS,
    "AllSales.csv": ALL_SALES_COLUMNS,
    "buildings.csv": BUILDINGS_COLUMNS,
    "BuildingSummarys.csv": BUILDING_SUMMARYS_COLUMNS,
    "ExtraFeature.csv": EXTRA_FEATURE_COLUMNS,
    "MailingLabels.csv": MAILING_LABELS_COLUMNS,
    "SalesQual.csv": SALES_QUAL_COLUMNS,
    "Subdivision.csv": SUBDIVISION_COLUMNS,
    "Taxes.csv": TAXES_COLUMNS,
}

#: Grain of each table relative to ``Parcel``, measured on the 2026-08-31 extract.
#:
#: This is the fact that makes a naive nine-way join unsafe: four of the nine tables are
#: many-rows-per-parcel, so joining them raw multiplies the 181,217-row spine by up to
#: 53 x 309 x 58 x 6. Every ``False`` here must be reduced to one row per parcel before
#: it touches the spine. :func:`assert_parcel_grain` enforces that at runtime.
PARCEL_GRAIN: Final[Mapping[str, bool]] = {
    "Parcels.csv": True,
    "AllSales.csv": False,
    "buildings.csv": False,
    "BuildingSummarys.csv": True,
    "ExtraFeature.csv": False,
    "MailingLabels.csv": True,
    "SalesQual.csv": True,
    # Not parcel-grain in any sense: 4,002 plat records whose own `Parcel` column
    # intersects the parcel spine only 3 times. It joins on normalised subdivision name.
    "Subdivision.csv": False,
    "Taxes.csv": False,
}

#: Inclusive row-count bounds per table, as a guard against a truncated or runaway
#: extract. Derived from the observed counts with generous slack (-25% / +50%): the
#: county grows by hundreds of parcels a year, not tens of thousands, so an extract
#: outside this band is a source-side accident rather than growth.
ROW_COUNT_BOUNDS: Final[Mapping[str, tuple[int, int]]] = {
    "Parcels.csv": (135_000, 275_000),
    "AllSales.csv": (639_000, 1_280_000),
    "buildings.csv": (129_000, 259_000),
    "BuildingSummarys.csv": (121_000, 243_000),
    "ExtraFeature.csv": (236_000, 474_000),
    "MailingLabels.csv": (134_000, 269_000),
    "SalesQual.csv": (117_000, 236_000),
    "Subdivision.csv": (3_000, 6_100),
    "Taxes.csv": (659_000, 1_319_000),
}


class SchemaDriftError(RuntimeError):
    """The source header no longer matches the contract.

    Raised — never logged and swallowed — because a shifted or renamed column produces
    output that looks plausible and is wrong. Failing the Glue run puts the terminal
    state on the EventBridge rule that pages on-call.
    """


class VolumeError(RuntimeError):
    """A table is empty, or its row count is outside the expected band."""


class GrainError(RuntimeError):
    """A table that must be one-row-per-parcel is not, so a join would fan out."""


def strip_bom(value: str) -> str:
    """Remove a leading UTF-8 BOM from a header cell.

    The Seminole extract writes the BOM on the first header cell of all nine files, so
    ``MasterId`` arrives as ``\\ufeffMasterId`` and every lookup on it misses.
    """
    return value.removeprefix(BOM)


def normalize_header(columns: Iterable[str]) -> tuple[str, ...]:
    """Strip the BOM and surrounding whitespace from every column name."""
    return tuple(strip_bom(column).strip() for column in columns)


def validate_table_schema(table: str, actual_columns: Sequence[str]) -> tuple[str, ...]:
    """Assert ``table``'s header matches its contract exactly, and return it normalised.

    Both directions are fatal. A missing column breaks a join or a derivation outright.
    An unexpected column means the county changed the layout, which is precisely the
    moment to stop and look rather than to publish a snapshot built on a guess.

    :raises SchemaDriftError: on any missing, unexpected, or reordered column.
    """
    expected = CAMA_TABLES.get(table)
    if expected is None:
        raise SchemaDriftError(
            f"{table}: not a known CAMA table (expected one of {list(CAMA_TABLES)})"
        )

    normalized = normalize_header(actual_columns)
    if normalized == expected:
        return normalized

    missing = [column for column in expected if column not in normalized]
    unexpected = [column for column in normalized if column not in expected]

    if missing or unexpected:
        raise SchemaDriftError(
            f"{table}: schema drift — missing={missing or None}, unexpected={unexpected or None}"
        )

    raise SchemaDriftError(
        f"{table}: column order changed — expected {list(expected)}, got {list(normalized)}"
    )


def assert_non_empty(table: str, row_count: int) -> None:
    """Assert ``table`` carried at least one data row.

    A zero-row CSV is the most common shape of a failed nightly rebuild upstream, and it
    would otherwise diff as "every parcel disappeared".
    """
    if row_count <= 0:
        raise VolumeError(f"{table}: source is empty ({row_count} rows) — refusing to process")


def assert_row_count_within_bounds(table: str, row_count: int) -> None:
    """Assert ``table``'s row count is non-empty and inside its expected band."""
    assert_non_empty(table, row_count)
    bounds = ROW_COUNT_BOUNDS.get(table)
    if bounds is None:
        return
    low, high = bounds
    if not low <= row_count <= high:
        raise VolumeError(
            f"{table}: row count {row_count:,} outside expected band {low:,}-{high:,}. "
            "Either the extract is truncated or the county changed — investigate before ingesting."
        )


def assert_parcel_grain(table: str, row_count: int, distinct_parcels: int) -> None:
    """Assert a table declared parcel-grain really is one row per parcel.

    Called immediately before the table is joined to the spine. Without it, a source-side
    change that starts emitting two rows per parcel would silently double the output.
    """
    if row_count != distinct_parcels:
        raise GrainError(
            f"{table}: expected one row per parcel but found {row_count:,} rows across "
            f"{distinct_parcels:,} parcels — joining this to the spine would fan out"
        )
