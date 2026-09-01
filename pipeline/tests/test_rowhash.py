"""Row-hash tests.

These exist to pin the hash against accidental change. If the column list, its order,
the separator, or the null encoding moves, the next nightly run reports all 181,217
parcels as `changed` and republishes the entire county. That failure is invisible in
production — the pipeline succeeds, it just lies — so it has to fail here.
"""

from __future__ import annotations

import hashlib

from oracle_pipeline.rowhash import (
    FIELD_SEPARATOR,
    HASHED_COLUMNS,
    canonical_row,
    hashed_columns_expression_order,
    normalize_value,
    row_hash,
)


def test_separator_cannot_occur_in_source_text() -> None:
    """ASCII unit separator: no CSV field value can forge a field boundary."""
    assert FIELD_SEPARATOR == "\x1f"


def test_hashed_columns_are_unique_and_ordered() -> None:
    assert len(HASHED_COLUMNS) == len(set(HASHED_COLUMNS))
    assert HASHED_COLUMNS[0] == "parcel_id"
    assert hashed_columns_expression_order() == HASHED_COLUMNS


def test_derived_columns_are_excluded_from_the_hash() -> None:
    """Derivations depend on the snapshot year, so hashing them would flip every parcel
    in the county on 1 January — a 181,217-row false positive, annually."""
    for derived in (
        "roof_age",
        "years_since_sale",
        "renovation_signal",
        "owner_out_of_area",
        "jurisdiction",
        "geohash5",
    ):
        assert derived not in HASHED_COLUMNS


def test_run_metadata_is_excluded_from_the_hash() -> None:
    for volatile in ("run_id", "ingested_at", "source_etag", "row_hash"):
        assert volatile not in HASHED_COLUMNS


def test_normalize_value_collapses_none_and_empty() -> None:
    """Spark's `concat_ws` drops nulls, so the pure mirror must encode them identically."""
    assert normalize_value(None) == ""
    assert normalize_value("") == ""
    assert normalize_value("  ") == ""


def test_normalize_value_lowercases_booleans_to_match_spark() -> None:
    assert normalize_value(True) == "true"
    assert normalize_value(False) == "false"


def test_normalize_value_stringifies_numbers() -> None:
    assert normalize_value(1998) == "1998"
    assert normalize_value(28.84273) == "28.84273"


def test_canonical_row_joins_with_the_separator() -> None:
    assert canonical_row(["01202930000100000", None, "Improved"]) == (
        f"01202930000100000{FIELD_SEPARATOR}{FIELD_SEPARATOR}Improved"
    )


def test_canonical_row_preserves_leading_zeros() -> None:
    assert canonical_row(["01202930000100000"]).startswith("012029")


def test_row_hash_is_sha256_of_the_canonical_form() -> None:
    """The digest is reproduced independently here, so the mirror is pinned to SHA-256
    rather than to whatever `row_hash` happens to call."""
    values = ["01202930000100000", "SMITH JOHN", None, "Improved"]
    expected = hashlib.sha256(canonical_row(values).encode("utf-8")).hexdigest()
    assert row_hash(values) == expected


def test_row_hash_is_stable_for_a_known_row() -> None:
    """A literal digest. Any change to separator, null encoding, or trimming breaks it."""
    assert row_hash(["01202930000100000", "Improved", 1998, None, True]) == (
        "2cdbf98bf51b1921a2d081687f992dd0fff30d3deec4f661516b2561831c2f31"
    )


def test_row_hash_detects_a_changed_field() -> None:
    before = row_hash(["01202930000100000", "SMITH JOHN", "Improved"])
    after = row_hash(["01202930000100000", "DOE JANE", "Improved"])
    assert before != after


def test_row_hash_is_order_sensitive() -> None:
    """Two fields swapping values must be a different row, not the same one."""
    assert row_hash(["a", "b"]) != row_hash(["b", "a"])


def test_row_hash_distinguishes_field_boundaries() -> None:
    """Without a separator that cannot appear in the data, `["ab", "c"]` and `["a", "bc"]`
    would collide and a changed parcel would be reported as unchanged."""
    assert row_hash(["ab", "c"]) != row_hash(["a", "bc"])


def test_row_hash_ignores_surrounding_whitespace() -> None:
    """The source pads some fields inconsistently between nightly rebuilds; that is not
    a change worth republishing a parcel for."""
    assert row_hash([" Improved "]) == row_hash(["Improved"])
