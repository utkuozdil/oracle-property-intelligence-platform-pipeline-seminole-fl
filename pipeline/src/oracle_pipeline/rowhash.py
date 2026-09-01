"""Canonical row fingerprinting for snapshot diffing.

The source's ``ETag`` is IIS-style — a timestamp plus a change number, not a digest of
the bytes — so a changed ETag means "the file was rebuilt", which it is every night at
04:00 whether or not a single parcel moved. The ETag is therefore only good enough to
skip a download; it can never answer "what actually changed". This module is what does.

The hash is computed in Spark as ``sha2(concat_ws(SEP, ...), 256)`` over the same column
list, in the same order, that :func:`canonical_row` joins here. Keeping a pure mirror of
the Spark expression is the point: ``tests/test_rowhash.py`` pins exact digests, so a
reordering or a change to the null encoding fails a local unit test instead of silently
marking all 181,217 parcels as ``changed`` on the next nightly run.
"""

from __future__ import annotations

import hashlib
from collections.abc import Sequence
from typing import Final

#: ASCII unit separator. Chosen because it cannot appear in the source CSV text, so no
#: field value can forge a boundary and make two different rows hash alike.
FIELD_SEPARATOR: Final = "\x1f"

#: Business columns that define a parcel's identity for change detection, in hash order.
#:
#: Deliberately excludes run metadata (`run_id`, `ingested_at`, `source_etag`) and the
#: derived columns. Derivations are a pure function of these inputs plus the snapshot
#: year, so hashing them too would mark every parcel in the county as `changed` on
#: 1 January — a 181,217-row false positive, every year.
HASHED_COLUMNS: Final[tuple[str, ...]] = (
    "parcel_id",
    "owner_name",
    "primary_address",
    "mailing_city_state_zip",
    "property_type",
    "vacant_improved",
    "legal_description",
    "subdivision",
    "tax_district",
    "dor_code",
    "zoning",
    "future_land_use",
    "has_homestead",
    "building_count",
    "year_built",
    "year_last_bldg_built",
    "max_effective_year_blt",
    "last_sale_date",
    "last_sale_amount",
    "total_just_value",
    "assessed_value",
    "taxable_value",
    "total_living_area",
    "total_bedrooms",
    "total_bathrooms",
    "max_building_height",
    "has_pool",
    "has_fireplace",
    "demolition_flag",
    "market_area",
    "neighborhood",
    "gis_acres",
    "latitude",
    "longitude",
    "sale_count",
    "building_count_detail",
    "extra_feature_count",
    "extra_feature_value",
    "annual_tax_total",
)


def normalize_value(value: object) -> str:
    """Render one field into its canonical hash text.

    ``None`` and the empty string both collapse to ``""``. They mean the same thing in
    this source — an absent value — and Spark's ``concat_ws`` drops nulls outright, so
    encoding them identically is what keeps the pure mirror faithful to the Spark
    expression rather than merely similar to it.

    Booleans are lowercased so Python's ``True`` and Spark's ``true`` agree.
    """
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value).strip()


def canonical_row(values: Sequence[object]) -> str:
    """Join field values into the exact string the Spark expression hashes."""
    return FIELD_SEPARATOR.join(normalize_value(value) for value in values)


def row_hash(values: Sequence[object]) -> str:
    """SHA-256 of a row's canonical form, as lowercase hex.

    SHA-256 rather than a cheaper non-cryptographic hash: at 181,217 rows the cost is
    irrelevant, and a collision here means a changed parcel is reported as unchanged and
    is never re-published.
    """
    return hashlib.sha256(canonical_row(values).encode("utf-8")).hexdigest()


def hashed_columns_expression_order() -> tuple[str, ...]:
    """Column order the Spark ``concat_ws`` must use to match :func:`row_hash`."""
    return HASHED_COLUMNS
