"""Geohash tests, including the partitioning behaviour over the county's real extent."""

from __future__ import annotations

import pytest

from oracle_pipeline.geohash import (
    GEOHASH_PRECISION,
    UNKNOWN_GEOHASH,
    encode,
    parse_coordinate,
)

# Seminole County bounding box, measured across all 181,217 parcels.
COUNTY_MIN_LAT = 28.61058
COUNTY_MAX_LAT = 28.84273
COUNTY_MIN_LON = -81.45964
COUNTY_MAX_LON = -80.99085


@pytest.mark.parametrize(
    ("latitude", "longitude", "expected"),
    [
        # Canonical reference vectors for the Niemeyer algorithm.
        (57.64911, 10.40744, "u4pruydqqvj"),
        (0.0, 0.0, "s0000000000"),
        (-90.0, -180.0, "00000000000"),
        (90.0, 180.0, "zzzzzzzzzzz"),
    ],
)
def test_encode_matches_reference_vectors(latitude: float, longitude: float, expected: str) -> None:
    assert encode(latitude, longitude, precision=len(expected)) == expected


def test_default_precision_is_five() -> None:
    assert GEOHASH_PRECISION == 5
    assert len(encode(28.7, -81.2)) == 5


def test_seminole_coordinates_land_in_the_expected_cells() -> None:
    """Sanford and Oviedo are ~25 km apart and must not share a precision-5 cell."""
    sanford = encode(28.8000, -81.2700)
    oviedo = encode(28.6700, -81.2080)
    assert sanford != oviedo
    assert all(cell.startswith("djn") for cell in (sanford, oviedo))


def test_precision_five_keeps_the_partition_count_workable() -> None:
    """A grid over the county's bounding box must yield tens of cells, not thousands.

    This is the sizing argument for precision 5 made executable: precision 6 would
    shatter 181,217 parcels into ~1,500 partitions averaging 120 rows each, which is the
    small-file problem that makes a Parquet dataset slower than the CSV it replaced.
    """
    steps = 60
    cells = {
        encode(
            COUNTY_MIN_LAT + (COUNTY_MAX_LAT - COUNTY_MIN_LAT) * i / steps,
            COUNTY_MIN_LON + (COUNTY_MAX_LON - COUNTY_MIN_LON) * j / steps,
        )
        for i in range(steps + 1)
        for j in range(steps + 1)
    }
    assert 10 <= len(cells) <= 80
    assert UNKNOWN_GEOHASH not in cells


def test_neighbouring_coordinates_share_a_prefix() -> None:
    """Locality is the point of partitioning on a geohash rather than on a hash."""
    a = encode(28.7000, -81.2000, precision=7)
    b = encode(28.7001, -81.2001, precision=7)
    assert a[:5] == b[:5]


@pytest.mark.parametrize(
    ("latitude", "longitude"),
    [(None, -81.2), (28.7, None), (None, None), (91.0, -81.2), (28.7, -181.0)],
)
def test_encode_returns_the_sentinel_for_unusable_coordinates(
    latitude: float | None, longitude: float | None
) -> None:
    """One bad coordinate must be a visible partition, not a failed 181k-row run."""
    assert encode(latitude, longitude) == UNKNOWN_GEOHASH


def test_encode_rejects_a_nonsense_precision() -> None:
    with pytest.raises(ValueError, match="precision must be at least 1"):
        encode(28.7, -81.2, precision=0)


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("28.84273", 28.84273),
        ("-81.45964", -81.45964),
        (" 28.7 ", 28.7),
        (28.7, 28.7),
        ("", None),
        (None, None),
        ("N/A", None),
    ],
)
def test_parse_coordinate(raw: str | float | None, expected: float | None) -> None:
    """Coordinates arrive as strings, for the same reason parcel ids do."""
    assert parse_coordinate(raw) == expected
