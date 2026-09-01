"""Phase 1 Seminole County property-roll transform.

Reads the nightly CAMA extract, validates it, reduces it to one row per parcel, derives
the roof/sale/renovation/owner/jurisdiction/geohash columns, diffs every parcel against
the previous snapshot by row hash, writes Parquet partitioned by ``geohash5``, and
reconciles the result against the FDOR second source.

The reconciliation is the one step here that reads a source this job did not acquire.
FDOR publishes annually while CAMA rebuilds nightly, so on almost every night there is no
FDOR snapshot belonging to this run and the pointer at ``raw/fdor/current.json`` is what
names the one to read. Its measured baselines live in :mod:`oracle_pipeline.reconcile`.

Everything decidable without Spark lives in ``oracle_pipeline`` as a pure function and is
covered by ``uv run pytest``. This module is the Spark wiring around those functions:
reads, joins, aggregations, the write, and the per-partition metric emission. It is
excluded from coverage for that reason — there is no assertion worth making about it
that does not require a cluster.

Three parsing traps are handled explicitly, all three observed in the 2026-08-31 extract:

1. **UTF-8 BOM on the header.** Every one of the nine files carries it, so ``MasterId``
   arrives as ``\\ufeffMasterId``. Columns are renamed through
   :func:`~oracle_pipeline.schema.normalize_header` immediately after the read.
2. **Embedded commas in quoted fields.** Legal descriptions and addresses contain them,
   so the reader must be quote-aware. Handled by the CSV reader options below.
3. **Embedded newlines in quoted fields.** ``SalesQual.csv`` has one in 150,796 of its
   157,166 rows — its 157,166 logical rows span 374,185 physical lines. This forces
   ``multiLine``; without it Spark reads more than twice the true row count as broken
   rows. It also means Spark cannot split these files, so read parallelism is capped at
   one task per file and the frame is repartitioned immediately afterwards.

``awsglue`` and ``pyspark`` are provided only by the Glue runtime, so they are not
installable locally and their imports are suppressed for basedpyright.
"""

from __future__ import annotations

import sys
import time
from collections.abc import Iterator
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any, Final

import boto3
from awsglue.context import GlueContext  # pyright: ignore[reportMissingImports]
from awsglue.job import Job  # pyright: ignore[reportMissingImports]
from awsglue.utils import getResolvedOptions  # pyright: ignore[reportMissingImports]
from pyspark.context import SparkContext  # pyright: ignore[reportMissingImports]
from pyspark.sql import Column, DataFrame, SparkSession  # pyright: ignore[reportMissingImports]

# `F` is the universal PySpark alias for the functions module. Renaming it to satisfy the
# lowercase-import rule would make every column expression below read unlike any other
# Spark code a reviewer has seen, so the rule is suppressed on the import instead.
from pyspark.sql import functions as F  # noqa: N812  # pyright: ignore[reportMissingImports]
from pyspark.sql.types import (  # pyright: ignore[reportMissingImports]
    BooleanType,
    IntegerType,
    StringType,
)
from pyspark.sql.window import Window  # pyright: ignore[reportMissingImports]

from oracle_pipeline import change_set as cs
from oracle_pipeline import derive, geohash
from oracle_pipeline import reconcile as rc
from oracle_pipeline.archive import expand_archive
from oracle_pipeline.constants import (
    COUNTY,
    FDOR_SOURCE_URL,
    SOURCE_URL,
    STAGED_PARCELS_PREFIX,
    raw_archive_key,
    raw_table_prefix,
)
from oracle_pipeline.manifests import (
    promote_manifest,
    read_current_manifest,
    read_fdor_pointer,
    write_change_set,
    write_manifest,
    write_reconciliation,
)
from oracle_pipeline.metrics import emit_partition_metrics
from oracle_pipeline.rowhash import FIELD_SEPARATOR, HASHED_COLUMNS
from oracle_pipeline.schema import (
    assert_parcel_grain,
    assert_row_count_within_bounds,
    normalize_header,
    validate_table_schema,
)

if TYPE_CHECKING:
    # Supplied by the Glue runtime alongside PySpark, so it is not a project dependency
    # and does not resolve locally. Imported for the `mapInPandas` annotations only.
    import pandas as pd  # pyright: ignore[reportMissingImports]

REQUIRED_ARGS = [
    "JOB_NAME",
    "data_bucket",
    "run_id",
    "source_etag",
    "source_last_modified",
    "source_fingerprint",
    "snapshot_year",
    "target_env",
]

#: Local scratch path on the Glue driver for the downloaded archive.
LOCAL_ARCHIVE = "/tmp/SeminoleCounty.zip"


def _read_table(spark: SparkSession, table: str, path: str) -> DataFrame:
    """Read one CAMA CSV as all-string columns, then validate its header.

    Every column is read as a string on purpose. Schema inference would cost a second
    full pass over 641 MB and would infer ``Parcel`` as a number, dropping the leading
    zero from 38,308 of the county's parcel ids. Casts happen later, explicitly, only
    where a column is used arithmetically.

    No explicit schema is supplied either, because supplying one would apply the expected
    names positionally and mask exactly the drift this is meant to catch.
    """
    frame = (
        spark.read.option("header", "true")
        .option("inferSchema", "false")
        .option("quote", '"')
        .option("escape", '"')
        # Mandatory: see trap 3 in the module docstring.
        .option("multiLine", "true")
        .option("encoding", "UTF-8")
        # Anything the parser cannot place is a fatal contract violation, not a row to
        # quietly null out. PERMISSIVE would hide the very corruption being guarded against.
        .option("mode", "FAILFAST")
        .csv(path)
    )
    renamed = frame.toDF(*normalize_header(frame.columns))
    validate_table_schema(table, renamed.columns)
    return renamed


def _as_double(column: str) -> Column:
    """Cast a string column to double, tolerating blanks and stray currency formatting."""
    return F.regexp_replace(F.coalesce(F.col(column), F.lit("")), r"[$,]", "").cast("double")


def _as_int(column: str) -> Column:
    return _as_double(column).cast(IntegerType())


def _as_boolean(column: str) -> Column:
    """Cast the source's ``'True'``/``'False'`` text to a real boolean, keeping null null.

    The distinction this protects is between "this parcel has no pool" and "we do not
    know whether this parcel has a pool". Both are common — a parcel with no
    ``SalesQual`` row has no ``CurrentHasBuilding`` at all — and collapsing the second
    into ``false`` would silently turn missing data into a negative fact. Lead scoring
    reads these columns, so an unknown scored as a definite "no" is a wrong answer that
    looks like a right one.

    Anything that is neither ``true`` nor ``false`` becomes null rather than being
    guessed at, and :func:`_assert_conversions_are_total` then fails the run if that
    happened to a value the source actually populated.
    """
    normalized = F.lower(F.trim(F.col(column)))
    return (
        F.when(normalized == "true", F.lit(True))
        .when(normalized == "false", F.lit(False))
        .otherwise(F.lit(None).cast(BooleanType()))
    )


#: Format the CAMA extract writes dates in, e.g. ``5/1/2017 12:00:00 AM``.
#:
#: Single-digit months and days are unpadded, and every value carries a midnight time
#: component that means nothing — the source records sale *dates*, not instants.
SOURCE_DATE_FORMAT: Final = "M/d/yyyy h:mm:ss a"


def _as_date(column: str) -> Column:
    """Parse the source's timestamp text to a real ``DATE``.

    Kept as ``DATE`` rather than ``TIMESTAMP`` because every source value is midnight;
    a timestamp would invite a consumer to read a precision that is not there, and would
    drag time-zone questions into a column that has no time in it.

    This is the retype that matters most for the query layer. A ``varchar`` date compares
    lexicographically, so ``'5/1/2017' < '7/1/1998'`` is true — a generated query filtering
    on a date range returns confidently wrong rows rather than raising, which is the worst
    of the available failure modes.
    """
    return F.to_date(F.to_timestamp(F.trim(F.col(column)), SOURCE_DATE_FORMAT))


def _register_udfs(spark: SparkSession, snapshot_year: int) -> None:
    """Expose the pure derivation functions to Spark SQL.

    Python UDFs rather than native Spark expressions: these are the functions the unit
    tests pin, and re-expressing them in Spark SQL would create a second implementation
    that the tests do not cover — the failure mode where the tested logic and the shipped
    logic drift apart. At 181,217 rows the serialisation overhead is seconds, which is a
    price worth paying to keep one implementation.
    """
    spark.udf.register(
        "udf_roof_age",
        lambda vi, yb, ylbb, meyb: derive.roof_age(vi, yb, ylbb, meyb, snapshot_year=snapshot_year),
        IntegerType(),
    )
    spark.udf.register(
        "udf_years_since_sale",
        lambda date, year: derive.years_since_sale(date, year, snapshot_year=snapshot_year),
        IntegerType(),
    )
    spark.udf.register(
        "udf_renovation_signal",
        lambda vi, yb, meyb: derive.renovation_signal(vi, yb, meyb, snapshot_year=snapshot_year),
        StringType(),
    )
    spark.udf.register("udf_jurisdiction", derive.jurisdiction, StringType())
    spark.udf.register("udf_owner_out_of_area", derive.owner_out_of_area, BooleanType())
    spark.udf.register("udf_normalize_subdivision", derive.normalize_subdivision_name, StringType())
    spark.udf.register(
        "udf_geohash5",
        lambda lat, lon: geohash.encode(
            geohash.parse_coordinate(lat), geohash.parse_coordinate(lon)
        ),
        StringType(),
    )

    # Reconciliation against the FDOR second source. Same reasoning as above: these are
    # the functions `tests/test_reconcile.py` pins, and the four that matter — the 2-digit
    # land-use truncation, the owner-name normalisation, the section/township/range
    # normalisation, and the mailing-blob parse — are each a comparison that was measured
    # wrong before it was measured right. Re-expressing any of them in Spark SQL would put
    # the tested version and the shipped version out of reach of each other.
    spark.udf.register("udf_cama_dor2", rc.cama_dor_code, IntegerType())
    spark.udf.register("udf_fdor_dor", rc.fdor_dor_code, IntegerType())
    spark.udf.register("udf_owner_key", rc.owner_name_key, StringType())
    spark.udf.register("udf_parcel_strng", rc.section_township_range_key, StringType())
    spark.udf.register("udf_fdor_strng", rc.fdor_section_township_range_key, StringType())
    spark.udf.register(
        "udf_mailing_state", lambda blob: derive.parse_city_state_zip(blob)[1], StringType()
    )
    spark.udf.register(
        "udf_mailing_zip", lambda blob: derive.parse_city_state_zip(blob)[2], StringType()
    )


def _reduce_sales(all_sales: DataFrame) -> DataFrame:
    """Reduce ``AllSales`` (853,095 rows, up to 53 per parcel) to one row per parcel.

    Carries the sale count and the amount of the most recent sale. Ordered by year then
    the source's own descending sale key, because the extract holds several sales per
    parcel per year and the key is the only tiebreak that is stable across runs — an
    unstable tiebreak would flip the row hash and report a spurious ``changed``.
    """
    latest = Window.partitionBy("Parcel").orderBy(
        F.col("SaleYear").cast("int").desc_nulls_last(),
        F.col("SaleKeyId").cast("long").desc_nulls_last(),
    )
    return (
        all_sales.withColumn("_rank", F.row_number().over(latest))
        .groupBy("Parcel")
        .agg(
            F.count(F.lit(1)).alias("sale_count"),
            F.max(F.when(F.col("_rank") == 1, _as_double("SaleAmt"))).alias("last_sale_amount"),
        )
    )


def _reduce_buildings(buildings: DataFrame) -> DataFrame:
    """Reduce ``buildings`` (172,382 rows, up to 309 per parcel) to one row per parcel."""
    primary = Window.partitionBy("Parcel").orderBy(
        _as_double("LivingArea").desc_nulls_last(),
        F.col("BldgId").cast("long").asc_nulls_last(),
    )
    return (
        buildings.withColumn("_rank", F.row_number().over(primary))
        .groupBy("Parcel")
        .agg(
            F.count(F.lit(1)).alias("building_count_detail"),
            F.max(F.when(F.col("_rank") == 1, F.col("ExteriorWallType"))).alias(
                "primary_exterior_wall"
            ),
            F.max(F.when(F.col("_rank") == 1, F.col("BuildingType"))).alias(
                "primary_building_type"
            ),
        )
    )


def _reduce_extra_features(extra_feature: DataFrame) -> DataFrame:
    """Reduce ``ExtraFeature`` (315,603 rows, up to 58 per parcel) to one row per parcel."""
    return extra_feature.groupBy("Parcel").agg(
        F.count(F.lit(1)).alias("extra_feature_count"),
        F.sum(_as_double("AppraisedValue")).alias("extra_feature_value"),
    )


def _reduce_taxes(taxes: DataFrame) -> DataFrame:
    """Reduce ``Taxes`` (878,680 rows, one per millage line) to one row per parcel.

    Every parcel has several millage lines — county, school, fire, water management —
    and the meaningful figure is their sum, not any single line.
    """
    return taxes.groupBy("Parcel").agg(
        F.sum(_as_double("Taxes")).alias("annual_tax_total"),
        F.sum(_as_double("Millage")).alias("total_millage"),
    )


def _join_spine(tables: dict[str, DataFrame]) -> DataFrame:
    """Join the nine tables onto the parcel spine at one row per parcel.

    Four of the nine are many-rows-per-parcel and are reduced first; joining them raw
    would multiply the 181,217-row spine by up to 53 x 309 x 58 x 6. The four that are
    genuinely parcel-grain are asserted to be so immediately before they are joined, so a
    source-side grain change fails the run instead of silently inflating the output.

    ``Subdivision`` is the exception to everything: it holds 4,002 plat records whose own
    ``Parcel`` column intersects the spine exactly 3 times. It joins on the normalised
    subdivision *name*, which matches 3,894 of the 4,047 distinct names on the spine.
    """
    spine = tables["Parcels.csv"]

    for table in ("BuildingSummarys.csv", "MailingLabels.csv", "SalesQual.csv"):
        frame = tables[table]
        assert_parcel_grain(table, frame.count(), frame.select("Parcel").distinct().count())

    building_summary = tables["BuildingSummarys.csv"].select(
        "Parcel",
        F.col("HasFireplace").alias("summary_has_fireplace"),
        F.col("HasPool").alias("summary_has_pool"),
        F.col("MaxYearBlt").alias("summary_max_year_built"),
    )
    mailing = tables["MailingLabels.csv"].select(
        "Parcel",
        F.col("CityStateZip").alias("mailing_city_state_zip"),
        F.concat_ws(" ", F.col("Address1"), F.col("Address2")).alias("mailing_street"),
    )
    # Source text is carried under `_source_*` so the published, typed column can own the
    # clean name and `_assert_conversions_are_total` can still see what it was parsed from.
    sales_qual = tables["SalesQual.csv"].select(
        "Parcel",
        F.col("SaleAmountPerLivingSqft").alias("_source_sale_per_sqft"),
        F.col("CurrentHasBuilding").alias("_source_has_building"),
    )
    subdivision = (
        tables["Subdivision.csv"]
        .select(
            F.expr("udf_normalize_subdivision(SubName)").alias("_sub_key"),
            F.col("SubId").alias("subdivision_id"),
            F.col("PlatAcreage").alias("_source_plat_acreage"),
        )
        .where(F.col("_sub_key").isNotNull())
        # The source holds one row per plat, but a defensive dedupe keeps a future
        # duplicate plat name from fanning out the spine through a name join.
        .dropDuplicates(["_sub_key"])
    )

    joined = (
        spine.join(building_summary, on="Parcel", how="left")
        .join(mailing, on="Parcel", how="left")
        .join(sales_qual, on="Parcel", how="left")
        .join(_reduce_sales(tables["AllSales.csv"]), on="Parcel", how="left")
        .join(_reduce_buildings(tables["buildings.csv"]), on="Parcel", how="left")
        .join(_reduce_extra_features(tables["ExtraFeature.csv"]), on="Parcel", how="left")
        .join(_reduce_taxes(tables["Taxes.csv"]), on="Parcel", how="left")
        .withColumn("_sub_key", F.expr("udf_normalize_subdivision(Subdivision)"))
        .join(subdivision, on="_sub_key", how="left")
        .drop("_sub_key")
    )
    return joined


def _derive_columns(joined: DataFrame) -> DataFrame:
    """Project the joined frame onto the published parcel schema.

    Column names become snake_case here — this is the boundary between the county's
    vocabulary and the pipeline's — and the six derived columns are computed from the
    pure functions registered as UDFs.
    """
    return joined.select(
        F.col("Parcel").alias("parcel_id"),
        F.col("MasterId").alias("master_id"),
        F.col("OwnerName").alias("owner_name"),
        F.col("PrimaryAddress").alias("primary_address"),
        F.col("mailing_city_state_zip"),
        F.col("mailing_street"),
        F.col("PrimaryPropertyType").alias("property_type"),
        F.col("VacantImproved").alias("vacant_improved"),
        F.col("LegalDescription").alias("legal_description"),
        F.col("Subdivision").alias("subdivision"),
        F.col("subdivision_id"),
        _as_double("_source_plat_acreage").alias("plat_acreage"),
        F.col("TaxDistrict").alias("tax_district"),
        F.col("DORCode").alias("dor_code"),
        F.col("Zoning").alias("zoning"),
        F.col("FutureLandUse").alias("future_land_use"),
        _as_boolean("HasHomestead").alias("has_homestead"),
        _as_int("BuildingCount").alias("building_count"),
        _as_int("YearBuilt").alias("year_built"),
        _as_int("YearLastBldgBuilt").alias("year_last_bldg_built"),
        _as_int("MaxEffectiveYearBlt").alias("max_effective_year_blt"),
        _as_date("LastSaleDate").alias("last_sale_date"),
        F.col("last_sale_amount"),
        _as_double("_source_sale_per_sqft").alias("last_sale_per_living_sqft"),
        F.col("sale_count"),
        _as_double("TotalJustValue").alias("total_just_value"),
        _as_double("AssessedValue").alias("assessed_value"),
        _as_double("TaxableValue").alias("taxable_value"),
        F.col("annual_tax_total"),
        F.col("total_millage"),
        _as_double("TotalLivingArea").alias("total_living_area"),
        _as_double("TotalBedrooms").alias("total_bedrooms"),
        _as_double("TotalBathrooms").alias("total_bathrooms"),
        _as_double("MaxBuildingHeight").alias("max_building_height"),
        _as_boolean("Pool").alias("has_pool"),
        _as_boolean("Fireplace").alias("has_fireplace"),
        _as_boolean("_source_has_building").alias("has_building"),
        F.col("building_count_detail"),
        F.col("primary_exterior_wall"),
        F.col("primary_building_type"),
        F.col("extra_feature_count"),
        F.col("extra_feature_value"),
        _as_boolean("DemolitionFlag").alias("demolition_flag"),
        F.col("MarketArea").alias("market_area"),
        F.col("Neighborhood").alias("neighborhood"),
        _as_double("SUM_GISAcres").alias("gis_acres"),
        _as_double("Latitude").alias("latitude"),
        _as_double("Longitude").alias("longitude"),
        # --- derived ---
        F.expr(
            "udf_roof_age(VacantImproved, YearBuilt, YearLastBldgBuilt, MaxEffectiveYearBlt)"
        ).alias("roof_age"),
        F.expr("udf_years_since_sale(LastSaleDate, LastSaleYear)").alias("years_since_sale"),
        F.expr("udf_renovation_signal(VacantImproved, YearBuilt, MaxEffectiveYearBlt)").alias(
            "renovation_signal"
        ),
        F.expr("udf_owner_out_of_area(mailing_city_state_zip)").alias("owner_out_of_area"),
        F.expr("udf_jurisdiction(TaxDistrict)").alias("jurisdiction"),
        F.expr("udf_geohash5(Latitude, Longitude)").alias("geohash5"),
    )


#: Typed columns paired with the source text they were parsed from.
#:
#: Used only by :func:`_assert_conversions_are_total`. Every entry is a place where a
#: parse can fail by returning null instead of raising.
TYPED_FROM_TEXT: Final[tuple[tuple[str, str], ...]] = (
    ("has_pool", "Pool"),
    ("has_fireplace", "Fireplace"),
    ("has_homestead", "HasHomestead"),
    ("demolition_flag", "DemolitionFlag"),
    ("has_building", "_source_has_building"),
    ("last_sale_date", "LastSaleDate"),
    ("last_sale_per_living_sqft", "_source_sale_per_sqft"),
    ("plat_acreage", "_source_plat_acreage"),
)


def _assert_conversions_are_total(joined: DataFrame, typed: DataFrame) -> None:
    """Fail the run if any populated source value failed to parse into its typed column.

    Spark's ``to_date`` and a ``cast`` to double both answer "I could not parse this" with
    null, indistinguishably from the source answering "I have no value here". That makes a
    type change the most dangerous kind of edit: it can quietly convert a populated column
    into an empty one and every row count downstream still looks right.

    So the two nulls are separated explicitly. For each retyped column, count the rows
    where the source text was non-blank but the typed value came out null. That number
    must be zero. If the county starts writing ``'Y'`` in ``Pool`` or switches to ISO
    dates, this is what says so — loudly, on the run that introduced it, rather than in a
    lead-scoring result three phases later.

    One pass: all checks are aggregated into a single row.
    """
    source = joined.select(
        *[F.col(text).alias(f"_text_{typed_name}") for typed_name, text in TYPED_FROM_TEXT],
        F.col("Parcel").alias("_parcel"),
    )
    combined = typed.select(
        *[F.col(typed_name) for typed_name, _ in TYPED_FROM_TEXT],
        F.col("parcel_id"),
    ).join(source, F.col("parcel_id") == F.col("_parcel"), how="inner")

    checks = [
        F.sum(
            F.when(
                F.trim(F.coalesce(F.col(f"_text_{typed_name}"), F.lit(""))).__ne__("")
                & F.col(typed_name).isNull(),
                F.lit(1),
            ).otherwise(F.lit(0))
        ).alias(typed_name)
        for typed_name, _ in TYPED_FROM_TEXT
    ]
    result = combined.agg(*checks).collect()[0].asDict()

    unparsed = {name: count for name, count in result.items() if (count or 0) > 0}
    if unparsed:
        details = ", ".join(f"{name}: {count:,}" for name, count in sorted(unparsed.items()))
        raise ValueError(
            f"source values failed to parse into their declared types ({details}) — "
            "the source's format changed and the typed column would be silently empty"
        )


def _with_row_hash(parcels: DataFrame) -> DataFrame:
    """Add the SHA-256 row hash used for change detection.

    Mirrors :func:`oracle_pipeline.rowhash.row_hash` exactly: same column order, same
    separator, and ``coalesce`` to the empty string before concatenation because
    ``concat_ws`` drops nulls outright, which would make ``[a, null, b]`` and ``[a, b]``
    hash identically. The pure mirror is what the unit tests pin.
    """
    fields = [F.coalesce(F.col(name).cast("string"), F.lit("")) for name in HASHED_COLUMNS]
    return parcels.withColumn("row_hash", F.sha2(F.concat_ws(FIELD_SEPARATOR, *fields), 256))


def _diff_against_prior(
    spark: SparkSession, current: DataFrame, prior_path: str | None
) -> tuple[dict[str, int], int]:
    """Classify every parcel against the prior snapshot and return the tally and its size.

    The prior snapshot is read as two columns only. Reading the full width to compare one
    hash would pull the entire previous county through the cluster for nothing.
    """
    if prior_path is None:
        # First run of the county: nothing to diff against, so every parcel is new.
        return (cs.empty_counts() | {cs.STATUS_NEW: current.count()}, 0)

    prior = spark.read.parquet(prior_path).select(
        F.col("parcel_id").alias("prior_parcel_id"),
        F.col("row_hash").alias("prior_row_hash"),
    )
    prior_total = prior.count()

    joined = current.select("parcel_id", "row_hash").join(
        prior,
        current["parcel_id"] == prior["prior_parcel_id"],
        how="full_outer",
    )

    status = (
        F.when(F.col("prior_row_hash").isNull(), F.lit(cs.STATUS_NEW))
        .when(F.col("row_hash").isNull(), F.lit(cs.STATUS_MISSING_ON_SOURCE))
        .when(F.col("row_hash") != F.col("prior_row_hash"), F.lit(cs.STATUS_CHANGED))
        .otherwise(F.lit(cs.STATUS_UNCHANGED))
    )

    tally = {
        row["status"]: row["count"]
        for row in joined.select(status.alias("status")).groupBy("status").count().collect()
    }
    return (tally, prior_total)


def _count_when(condition: Column) -> Column:
    """A conditional row count that yields 0 rather than null on an empty frame."""
    return F.sum(F.when(condition, F.lit(1)).otherwise(F.lit(0)))


def _read_fdor_snapshot(spark: SparkSession, bucket: str, prefix: str) -> DataFrame:
    """Read the raw Esri JSON the ``FetchFdor`` step landed, and repair its two encodings.

    Each object under the prefix is one window's response, stored exactly as the service
    served it: ``{"features": [{"attributes": {...}, "geometry": {"x": ..., "y": ...}}]}``.
    A window that had to sub-page holds one such document per line, which is why the
    default line-delimited JSON reader is the right one.

    Two source encodings are undone here rather than at every comparison site:

    1. **Zero means missing.** FDOR writes ``0``, not null, for an absent numeric.
       160,275 of 179,107 parcels carry ``SALE_PRC1 = 0`` simply because they had no sale
       in the assessment cycle. Compared as zeros they are not missing data, they are
       179,107 confident disagreements, and every aggregate built on them is wrong while
       nothing raises.
    2. **A single space means blank.** Several string fields use ``' '`` rather than
       ``''`` or null, ``QUAL_CD1`` among them — which would make every unqualified sale
       look like it carried a code.
    """
    responses = spark.read.json(f"s3://{bucket}/{prefix}window-*.json")
    features = responses.select(F.explode(F.col("features")).alias("feature"))
    frame = features.select(
        F.col("feature.attributes.*"),
        # Requested at `outSR=4326`, so these are already lon/lat degrees.
        F.col("feature.geometry.x").alias("fdor_longitude"),
        F.col("feature.geometry.y").alias("fdor_latitude"),
    )

    for field in rc.ZERO_IS_NULL_FIELDS:
        if field in frame.columns:
            frame = frame.withColumn(
                field, F.when(F.col(field) == 0, F.lit(None)).otherwise(F.col(field))
            )

    for field in rc.SPACE_IS_BLANK_FIELDS:
        if field in frame.columns:
            trimmed = F.trim(F.col(field))
            frame = frame.withColumn(
                field, F.when(trimmed == F.lit(""), F.lit(None)).otherwise(trimmed)
            )

    return frame


def _measure_overlap(parcels: DataFrame, fdor: DataFrame) -> rc.Overlap:
    """Size the three sets a full outer join on the parcel id produces.

    The join needs no normalisation at all: both sides are 100% 17-character uppercase
    alphanumeric with zero whitespace and zero case variance. The ``upper``/``trim`` here
    are documented no-ops kept because they cost nothing and would absorb a source-side
    formatting change instead of silently halving the match rate.

    The two-sided breakdown is the operationally useful figure, not the net gap. 2,355
    CAMA-only and 244 FDOR-only is 2,355 additions and 244 retirements; the net 2,111
    describes neither.
    """
    cama_keys = parcels.select(F.upper(F.trim(F.col("parcel_id"))).alias("key")).distinct()
    fdor_keys = fdor.select(F.upper(F.trim(F.col("PARCEL_ID"))).alias("key")).distinct()

    both = cama_keys.alias("c").join(
        fdor_keys.alias("f"), F.col("c.key") == F.col("f.key"), how="full_outer"
    )
    row = both.agg(
        _count_when(F.col("c.key").isNotNull() & F.col("f.key").isNotNull()).alias("matched"),
        _count_when(F.col("f.key").isNull()).alias("cama_only"),
        _count_when(F.col("c.key").isNull()).alias("fdor_only"),
        F.count(F.col("c.key")).alias("cama_total"),
        F.count(F.col("f.key")).alias("fdor_total"),
    ).collect()[0]

    return rc.Overlap(
        cama_total=int(row["cama_total"]),
        fdor_total=int(row["fdor_total"]),
        matched=int(row["matched"]),
        cama_only=int(row["cama_only"]),
        fdor_only=int(row["fdor_only"]),
    )


def _relative_just_value_delta() -> Column:
    """``|CAMA - FDOR| / |FDOR|``, guarding the nominal-value parcels.

    8,897 parcels carry a nominal ``JV`` and a handful could in principle be zero, so the
    denominator is checked rather than assumed. Two zeros agree exactly; a zero against a
    non-zero has no meaningful ratio and is left null so it falls outside every band.
    """
    return F.when(
        F.col("JV") == 0,
        F.when(F.col("total_just_value") == 0, F.lit(0.0)).otherwise(F.lit(None)),
    ).otherwise(F.abs(F.col("total_just_value") - F.col("JV")) / F.abs(F.col("JV")))


def _measure_matched_fields(parcels: DataFrame, fdor: DataFrame) -> dict[str, int]:
    """Every field comparison on the matched parcels, in one aggregation pass.

    One pass rather than a query per field: each of these is a full shuffle of the
    county, and twenty of them would cost far more than the transform they are checking.
    """
    cama = parcels.select(
        F.upper(F.trim(F.col("parcel_id"))).alias("key"),
        "total_living_area",
        "year_built",
        "max_effective_year_blt",
        "dor_code",
        "total_just_value",
        "assessed_value",
        "owner_name",
        "last_sale_date",
        "last_sale_amount",
        "latitude",
        "longitude",
        "mailing_city_state_zip",
    )
    theirs = fdor.select(
        F.upper(F.trim(F.col("PARCEL_ID"))).alias("key"),
        "TOT_LVG_AR",
        "ACT_YR_BLT",
        "EFF_YR_BLT",
        "DOR_UC",
        "JV",
        "AV_SD",
        "OWN_NAME",
        "QUAL_CD1",
        "SALE_PRC1",
        "SALE_YR1",
        "OWN_STATE",
        "OWN_ZIPCD",
        "fdor_latitude",
        "fdor_longitude",
    )
    matched = cama.join(theirs, on="key", how="inner")

    living_area_both = F.col("total_living_area").isNotNull() & F.col("TOT_LVG_AR").isNotNull()
    year_built_both = F.col("year_built").isNotNull() & F.col("ACT_YR_BLT").isNotNull()
    effective_both = F.col("max_effective_year_blt").isNotNull() & F.col("EFF_YR_BLT").isNotNull()

    cama_dor = F.expr("udf_cama_dor2(dor_code)")
    fdor_dor = F.expr("udf_fdor_dor(DOR_UC)")
    dor_both = cama_dor.isNotNull() & fdor_dor.isNotNull()

    just_value_both = F.col("total_just_value").isNotNull() & F.col("JV").isNotNull()
    relative_delta = _relative_just_value_delta()

    assessed_both = F.col("assessed_value").isNotNull() & F.col("AV_SD").isNotNull()

    # Truncation-aware *and* punctuation-insensitive, which is one measure rather than
    # two. `OWN_NAME` is hard-capped at 30 characters and 50,287 CAMA names are longer, so
    # the prefix test handles the truncation; the normalisation handles the formatting
    # divergence between the two exports. Dropping either one scores in the 60s.
    cama_owner_key = F.expr("udf_owner_key(owner_name)")
    fdor_owner_key = F.expr("udf_owner_key(OWN_NAME)")
    owner_both = cama_owner_key.isNotNull() & fdor_owner_key.isNotNull()
    owner_prefix = cama_owner_key.startswith(fdor_owner_key)

    # The qualification gate. Everything about the sale comparison depends on it: 94.39%
    # gated against 51.8% ungated, and the ungated figure had CAMA looking *older* than
    # FDOR on 7,217 rows, which is the wrong direction for staleness and the tell that
    # the comparison rather than the data was at fault.
    cama_sale_year = F.year(F.col("last_sale_date"))
    sale_comparable = F.col("SALE_YR1").isNotNull() & cama_sale_year.isNotNull()
    qualified = F.col("QUAL_CD1").isin(list(rc.QUALIFIED_SALE_CODES))
    # Enumerated, not complemented. The 1.97% control was measured on codes 11/14/30; the
    # complement of the qualified set also picks up the sparse remaining codes, which look
    # far more like market sales and take the figure to 5.61%.
    unqualified = F.col("QUAL_CD1").isin(list(rc.UNQUALIFIED_SALE_CODES))

    mailing_state = F.expr("udf_mailing_state(mailing_city_state_zip)")
    mailing_zip = F.expr("udf_mailing_zip(mailing_city_state_zip)")
    fdor_state = F.upper(F.trim(F.col("OWN_STATE")))
    fdor_zip = F.lpad(F.col("OWN_ZIPCD").cast(IntegerType()).cast(StringType()), 5, "0")

    coordinates_both = (
        F.col("latitude").isNotNull()
        & F.col("longitude").isNotNull()
        & F.col("fdor_latitude").isNotNull()
        & F.col("fdor_longitude").isNotNull()
    )
    coordinates_identical = (
        F.round(F.col("latitude"), 6) == F.round(F.col("fdor_latitude"), 6)
    ) & (F.round(F.col("longitude"), 6) == F.round(F.col("fdor_longitude"), 6))

    row = matched.agg(
        _count_when(living_area_both).alias("living_area_comparable"),
        _count_when(living_area_both & (F.col("total_living_area") == F.col("TOT_LVG_AR"))).alias(
            "living_area_exact"
        ),
        _count_when(
            living_area_both
            & (
                F.abs(F.col("total_living_area") - F.col("TOT_LVG_AR"))
                > F.lit(0.10) * F.abs(F.col("TOT_LVG_AR"))
            )
        ).alias("living_area_beyond"),
        _count_when(year_built_both).alias("year_built_comparable"),
        _count_when(year_built_both & (F.col("year_built") == F.col("ACT_YR_BLT"))).alias(
            "year_built_exact"
        ),
        _count_when(
            year_built_both & (F.abs(F.col("year_built") - F.col("ACT_YR_BLT")) > F.lit(1))
        ).alias("year_built_beyond"),
        _count_when(effective_both).alias("effective_comparable"),
        _count_when(
            effective_both & (F.col("max_effective_year_blt") == F.col("EFF_YR_BLT"))
        ).alias("effective_exact"),
        _count_when(
            effective_both
            & (F.abs(F.col("max_effective_year_blt") - F.col("EFF_YR_BLT")) > F.lit(1))
        ).alias("effective_beyond"),
        _count_when(dor_both).alias("dor_comparable"),
        _count_when(dor_both & (cama_dor == fdor_dor)).alias("dor_exact"),
        _count_when(dor_both & (cama_dor != fdor_dor)).alias("dor_beyond"),
        _count_when(just_value_both).alias("just_value_comparable"),
        _count_when(just_value_both & (F.col("total_just_value") == F.col("JV"))).alias(
            "just_value_exact"
        ),
        _count_when(just_value_both & (relative_delta <= F.lit(0.01))).alias("just_value_within_1"),
        _count_when(just_value_both & (relative_delta <= F.lit(0.05))).alias("just_value_within_5"),
        _count_when(just_value_both & (relative_delta <= F.lit(0.10))).alias(
            "just_value_within_10"
        ),
        _count_when(just_value_both & (relative_delta <= F.lit(0.25))).alias(
            "just_value_within_25"
        ),
        _count_when(assessed_both).alias("assessed_comparable"),
        _count_when(assessed_both & (F.col("assessed_value") == F.col("AV_SD"))).alias(
            "assessed_exact"
        ),
        _count_when(owner_both).alias("owner_name_comparable"),
        _count_when(owner_both & owner_prefix).alias("owner_name_prefix"),
        _count_when(qualified & sale_comparable).alias("qualified_comparable"),
        _count_when(qualified & sale_comparable & (cama_sale_year == F.col("SALE_YR1"))).alias(
            "qualified_year_exact"
        ),
        _count_when(
            qualified & sale_comparable & (F.col("last_sale_amount") == F.col("SALE_PRC1"))
        ).alias("qualified_price_exact"),
        _count_when(unqualified & sale_comparable).alias("unqualified_comparable"),
        _count_when(unqualified & sale_comparable & (cama_sale_year == F.col("SALE_YR1"))).alias(
            "unqualified_year_exact"
        ),
        _count_when(mailing_state.isNull() & fdor_state.isNotNull()).alias("state_backfilled"),
        _count_when(mailing_zip.isNull() & F.col("OWN_ZIPCD").isNotNull()).alias("zip_backfilled"),
        _count_when(
            mailing_state.isNotNull() & fdor_state.isNotNull() & (mailing_state != fdor_state)
        ).alias("state_disagreements"),
        _count_when(
            mailing_zip.isNotNull() & F.col("OWN_ZIPCD").isNotNull() & (mailing_zip != fdor_zip)
        ).alias("zip_disagreements"),
        _count_when(coordinates_both).alias("coordinates_compared"),
        _count_when(coordinates_both & coordinates_identical).alias("coordinates_identical"),
    ).collect()[0]

    return {name: int(value or 0) for name, value in row.asDict().items()}


def _measure_section_township_range(fdor: DataFrame) -> tuple[int, int]:
    """Validate the parcel id's embedded SEC/TWN/RNG against FDOR's discrete columns.

    Measured over every FDOR row rather than over the matched set, because this is a
    property of the key itself and does not depend on the join. It is also the evidence
    behind the precedence decision: at 179,106 of 179,107 the pipeline already has these
    three fields in the nightly parcel id and does not need an annual snapshot to supply
    them.
    """
    row = fdor.agg(
        F.count(F.lit(1)).alias("compared"),
        _count_when(
            F.expr("udf_parcel_strng(PARCEL_ID)").isNotNull()
            & (F.expr("udf_parcel_strng(PARCEL_ID)") == F.expr("udf_fdor_strng(SEC, TWN, RNG)"))
        ).alias("agree"),
    ).collect()[0]
    return (int(row["compared"]), int(row["agree"] or 0))


def _reconcile_against_fdor(
    spark: SparkSession,
    *,
    bucket: str,
    run_id: str,
    parcels: DataFrame,
    snapshot_year: int,
    source_fingerprint: str,
    started_at: str,
    s3: Any,
) -> tuple[dict[str, Any] | None, str | None]:
    """Join the FDOR snapshot to the night's parcels and write the reconciliation report.

    Returns ``(None, None)`` when no FDOR snapshot has ever been landed. That is a normal
    state on the first run of a county and after an acquisition failure that predates any
    successful one, and it must not stop the night: this is a cross-check on the parcels,
    not a step in producing them.

    Which snapshot is read comes from the pointer rather than from this run, because FDOR
    publishes annually and on almost every night the run has no snapshot of its own.
    """
    pointer = read_fdor_pointer(bucket, client=s3)
    if not pointer or not pointer.get("prefix"):
        return (None, None)

    prefix = str(pointer["prefix"])
    fdor = _read_fdor_snapshot(spark, bucket, prefix).cache()

    overlap = _measure_overlap(parcels, fdor)
    measured = _measure_matched_fields(parcels, fdor)
    strng_compared, strng_agree = _measure_section_township_range(fdor)

    assessment_years = [
        int(row["ASMNT_YR"])
        for row in fdor.select("ASMNT_YR").distinct().collect()
        if row["ASMNT_YR"] is not None
    ]

    document = rc.build_reconciliation_document(
        run_id=run_id,
        county=COUNTY,
        cama_source_url=SOURCE_URL,
        cama_source_fingerprint=source_fingerprint,
        fdor_source_url=FDOR_SOURCE_URL,
        fdor_snapshot_prefix=prefix,
        fdor_snapshot_token=str(pointer.get("snapshotToken", "")),
        # A single value across the whole snapshot on the measured extract. More than one
        # would mean the layer mixes assessment years, which changes what every value
        # comparison below means.
        fdor_assessment_year=assessment_years[0] if len(assessment_years) == 1 else None,
        snapshot_year=snapshot_year,
        started_at=started_at,
        finished_at=datetime.now(UTC).isoformat(),
        overlap=overlap,
        living_area=rc.FieldComparison(
            comparable=measured["living_area_comparable"],
            exact=measured["living_area_exact"],
            beyond_tolerance=measured["living_area_beyond"],
        ),
        year_built=rc.FieldComparison(
            comparable=measured["year_built_comparable"],
            exact=measured["year_built_exact"],
            beyond_tolerance=measured["year_built_beyond"],
        ),
        effective_year=rc.FieldComparison(
            comparable=measured["effective_comparable"],
            exact=measured["effective_exact"],
            beyond_tolerance=measured["effective_beyond"],
        ),
        dor_code=rc.FieldComparison(
            comparable=measured["dor_comparable"],
            exact=measured["dor_exact"],
            beyond_tolerance=measured["dor_beyond"],
        ),
        assessed_value=rc.FieldComparison(
            comparable=measured["assessed_comparable"],
            exact=measured["assessed_exact"],
        ),
        just_value=rc.JustValueBands(
            comparable=measured["just_value_comparable"],
            exact=measured["just_value_exact"],
            within_1pct=measured["just_value_within_1"],
            within_5pct=measured["just_value_within_5"],
            within_10pct=measured["just_value_within_10"],
            within_25pct=measured["just_value_within_25"],
        ),
        sales=rc.SaleComparison(
            qualified_comparable=measured["qualified_comparable"],
            qualified_year_exact=measured["qualified_year_exact"],
            qualified_price_exact=measured["qualified_price_exact"],
            unqualified_comparable=measured["unqualified_comparable"],
            unqualified_year_exact=measured["unqualified_year_exact"],
        ),
        owner=rc.OwnerComparison(
            name_comparable=measured["owner_name_comparable"],
            name_prefix_match=measured["owner_name_prefix"],
            state_backfilled=measured["state_backfilled"],
            zip_backfilled=measured["zip_backfilled"],
            state_disagreements=measured["state_disagreements"],
            zip_disagreements=measured["zip_disagreements"],
        ),
        null_results=rc.NullResults(
            coordinates_compared=measured["coordinates_compared"],
            coordinates_identical_6dp=measured["coordinates_identical"],
            section_township_range_compared=strng_compared,
            section_township_range_agree=strng_agree,
        ),
    )

    fdor.unpersist()
    key = write_reconciliation(bucket, run_id, document, client=s3)
    return (document, key)


def _instrumented(frame: DataFrame, environment: str) -> DataFrame:
    """Emit one metric set per Spark partition as that partition streams to the writer.

    This is the per-worker-unit requirement. ``mapInPandas`` runs on the executors and is
    consumed lazily by the write, so each partition's ``ParcelProcessed`` count is
    published the moment its rows have been handed to the Parquet writer — the counter
    climbs in CloudWatch during the run instead of appearing as a single value at the end.

    The frame is repartitioned by ``geohash5`` before this, so a partition is one output
    cell: roughly forty emissions of a few thousand parcels each across the county.
    """

    def instrument(batches: Iterator[pd.DataFrame]) -> Iterator[pd.DataFrame]:
        from pyspark import TaskContext  # pyright: ignore[reportMissingImports]

        context = TaskContext.get()
        partition_index = context.partitionId() if context is not None else -1
        started = time.perf_counter()
        rows = 0
        try:
            for batch in batches:
                rows += len(batch)
                yield batch
        except Exception:
            emit_partition_metrics(
                partition_index=partition_index,
                rows_processed=rows,
                rows_failed=1,
                duration_ms=(time.perf_counter() - started) * 1000,
                environment=environment,
            )
            raise
        emit_partition_metrics(
            partition_index=partition_index,
            rows_processed=rows,
            rows_failed=0,
            duration_ms=(time.perf_counter() - started) * 1000,
            environment=environment,
        )

    return frame.mapInPandas(instrument, schema=frame.schema)


def main() -> None:
    args = getResolvedOptions(sys.argv, REQUIRED_ARGS)
    bucket = args["data_bucket"]
    run_id = args["run_id"]
    environment = args["target_env"]
    started_at = datetime.now(UTC).isoformat()

    # Passed explicitly by the state machine so a replay of an old run derives the same
    # ages it originally did; falls back to now only for a manual console run.
    snapshot_year = int(args["snapshot_year"]) if args["snapshot_year"] else datetime.now(UTC).year

    spark_context = SparkContext.getOrCreate()
    glue_context = GlueContext(spark_context)
    spark: SparkSession = glue_context.spark_session
    job = Job(glue_context)
    job.init(args["JOB_NAME"], args)
    logger = glue_context.get_logger()

    # Re-running the same `run_id` must overwrite that run's partitions and leave every
    # other partition alone, so a redrive is safe and never half-deletes the county.
    spark.conf.set("spark.sql.sources.partitionOverwriteMode", "dynamic")
    spark.conf.set("spark.sql.parquet.compression.codec", "snappy")

    s3 = boto3.client("s3")

    # --- 1. expand the archive the acquire step already validated and stored ----------
    archive_key = raw_archive_key(run_id)
    s3.download_file(bucket, archive_key, LOCAL_ARCHIVE)
    expanded = expand_archive(
        archive_path=LOCAL_ARCHIVE,
        bucket=bucket,
        destination_prefix=raw_table_prefix(run_id),
        client=s3,
    )
    logger.info(f"Expanded {len(expanded)} CAMA tables from s3://{bucket}/{archive_key}")

    _register_udfs(spark, snapshot_year)

    # --- 2. read and validate ---------------------------------------------------------
    tables: dict[str, DataFrame] = {}
    row_counts: dict[str, int] = {}
    for entry in expanded:
        frame = _read_table(spark, entry.table, f"s3://{bucket}/{entry.key}")
        # multiLine forbids splitting, so each file arrives as a single partition.
        # Repartitioning here is what lets the joins use the whole cluster.
        frame = frame.repartition(32).cache()
        count = frame.count()
        assert_row_count_within_bounds(entry.table, count)
        tables[entry.table] = frame
        row_counts[entry.table] = count
        logger.info(f"{entry.table}: {count:,} rows, schema validated")

    # --- 3. join to one row per parcel, then derive ------------------------------------
    joined = _join_spine(tables).cache()
    typed = _derive_columns(joined)

    # Before anything downstream trusts the typed columns: prove no populated source value
    # was turned into a null by a failed parse.
    _assert_conversions_are_total(joined, typed)

    parcels = _with_row_hash(typed)
    parcels = parcels.cache()
    current_total = parcels.count()
    assert_parcel_grain(
        "joined-snapshot", current_total, parcels.select("parcel_id").distinct().count()
    )

    # --- 4. diff against the prior snapshot -------------------------------------------
    prior_manifest = read_current_manifest(bucket, client=s3)
    prior_path = prior_manifest.get("stagedPath") if prior_manifest else None
    counts, prior_total = _diff_against_prior(spark, parcels, prior_path)
    cs.assert_delta_is_plausible(counts, prior_total=prior_total)

    # --- 5. write Parquet, partitioned by geohash5, metering as it goes ----------------
    staged_path = f"s3://{bucket}/{STAGED_PARCELS_PREFIX}"
    partitioned = parcels.repartition("geohash5")
    _instrumented(partitioned, environment).write.mode("overwrite").partitionBy("geohash5").parquet(
        staged_path
    )
    partition_count = parcels.select("geohash5").distinct().count()

    # --- 6. reconcile against the FDOR second source -----------------------------------
    #
    # After the Parquet is written and before the manifest is promoted, which is the only
    # placement that gets both halves of the requirement right. The report is durable on
    # S3 before anything can fail, so an operator can read exactly which figure moved. But
    # the manifest pointer has not flipped yet, so a snapshot whose reconciliation drifted
    # is not adopted as the one the next run diffs against and is never published.
    reconciliation, reconciliation_object = _reconcile_against_fdor(
        spark,
        bucket=bucket,
        run_id=run_id,
        parcels=parcels,
        snapshot_year=snapshot_year,
        source_fingerprint=args["source_fingerprint"],
        started_at=started_at,
        s3=s3,
    )
    if reconciliation is None:
        logger.warn(
            "No FDOR snapshot is in force; skipping reconciliation. The night's parcels "
            "are unaffected — this is a cross-check, not a precondition."
        )
    else:
        overlap = reconciliation["overlap"]
        logger.info(
            f"FDOR reconciliation: {overlap['matched']:,} matched "
            f"({overlap['matchedShareOfCama']:.2%} of CAMA, "
            f"{overlap['matchedShareOfFdor']:.2%} of FDOR), "
            f"{overlap['camaOnly']:,} CAMA-only, {overlap['fdorOnly']:,} FDOR-only; "
            f"report at s3://{bucket}/{reconciliation_object}"
        )
        # Raised only after the report is on S3. These baselines were measured against
        # live data and are reproducible, so a deviation is a broken join, a lost
        # zero-to-null conversion, or a dropped qualification gate — none of which fail
        # the run on their own, and all of which produce confidently wrong output.
        rc.assert_reconciliation_matches_expected(reconciliation)

    # --- 7. change set, manifest, and the atomic pointer swap --------------------------
    finished_at = datetime.now(UTC).isoformat()
    document = cs.build_change_set_document(
        run_id=run_id,
        county=COUNTY,
        source_url=SOURCE_URL,
        source_etag=args["source_etag"] or None,
        source_last_modified=args["source_last_modified"] or None,
        source_fingerprint=args["source_fingerprint"],
        snapshot_year=snapshot_year,
        started_at=started_at,
        finished_at=finished_at,
        counts=counts,
        prior_total=prior_total,
        current_total=current_total,
        staged_prefix=staged_path,
        partition_count=partition_count,
    )
    change_set_object = write_change_set(bucket, run_id, document, client=s3)

    manifest: dict[str, Any] = {
        "runId": run_id,
        "county": COUNTY,
        "phase": "phase-1",
        "sources": [entry.table for entry in expanded],
        "recordCounts": row_counts,
        "parcelCount": current_total,
        "snapshotYear": snapshot_year,
        "stagedPath": staged_path,
        "changeSetKey": change_set_object,
        # Null when no FDOR snapshot was in force. Recorded either way so a consumer can
        # tell "reconciled and agreed" from "not reconciled at all".
        "reconciliationKey": reconciliation_object,
        "sourceFingerprint": args["source_fingerprint"],
        "startedAt": started_at,
        "finishedAt": finished_at,
    }
    write_manifest(bucket=bucket, run_id=run_id, payload=manifest)
    # Only after the Parquet is durable: this pointer's contract is "the last complete run".
    promote_manifest(bucket, run_id, client=s3)

    logger.info(
        f"Phase 1 complete: {current_total:,} parcels across {partition_count} geohash5 "
        f"partitions; change set at s3://{bucket}/{change_set_object}; "
        f"reconciliation at {reconciliation_object or '(none — no FDOR snapshot in force)'}"
    )

    job.commit()


if __name__ == "__main__":
    main()
