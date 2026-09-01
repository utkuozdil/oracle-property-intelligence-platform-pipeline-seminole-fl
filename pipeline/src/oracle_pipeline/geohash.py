"""Geohash encoding, implemented rather than imported.

Written out because the alternative is shipping a PyPI dependency into the Glue job's
``--additional-python-modules`` for forty lines of bit interleaving, and every extra
wheel is another thing that can fail to resolve at job start. The algorithm is the
standard Niemeyer base-32 geohash and is pinned by the reference vectors in
``tests/test_geohash.py``.

Precision 5 is the partition key for the staged Parquet. On Seminole's bounding box
(28.61058-28.84273 N, -81.45964 - -80.99085 W) a precision-5 cell is roughly 4.9 km
square, which lands the 181,217 parcels in a few dozen partitions of low tens of
thousands of rows each. Precision 6 would shatter that into ~1,500 partitions averaging
120 rows — the small-file problem that makes a Parquet dataset slower than the CSV it
replaced. Precision 4 collapses the whole county into a handful of cells and buys no
locality at all.
"""

from __future__ import annotations

from typing import Final

#: Niemeyer base-32: digits plus lowercase consonants, with `a`, `i`, `l`, `o` removed.
BASE32: Final = "0123456789bcdefghjkmnpqrstuvwxyz"

_BITS: Final = (16, 8, 4, 2, 1)

#: Partition precision for the staged parcel snapshot.
GEOHASH_PRECISION: Final = 5

MIN_LATITUDE: Final = -90.0
MAX_LATITUDE: Final = 90.0
MIN_LONGITUDE: Final = -180.0
MAX_LONGITUDE: Final = 180.0

#: Written to the partition column when a parcel has no usable coordinate. Spark cannot
#: partition on null, and a literal is easier to spot in a listing than `__HIVE_DEFAULT`.
#: Not reachable on the current extract — latitude and longitude are 100% populated
#: across all 181,217 rows — but a partition column may not be null-valued on any run.
UNKNOWN_GEOHASH: Final = "nogeo"


def encode(
    latitude: float | None,
    longitude: float | None,
    precision: int = GEOHASH_PRECISION,
) -> str:
    """Encode a coordinate as a geohash of ``precision`` characters.

    Returns :data:`UNKNOWN_GEOHASH` for missing or out-of-range coordinates rather than
    raising, because one bad coordinate must not fail a 181k-row run — it must be
    visible as its own partition.
    """
    if latitude is None or longitude is None:
        return UNKNOWN_GEOHASH
    if not MIN_LATITUDE <= latitude <= MAX_LATITUDE:
        return UNKNOWN_GEOHASH
    if not MIN_LONGITUDE <= longitude <= MAX_LONGITUDE:
        return UNKNOWN_GEOHASH
    if precision < 1:
        raise ValueError(f"precision must be at least 1, got {precision}")

    lat_range = [MIN_LATITUDE, MAX_LATITUDE]
    lon_range = [MIN_LONGITUDE, MAX_LONGITUDE]

    characters: list[str] = []
    bit = 0
    accumulator = 0
    even_bit = True

    while len(characters) < precision:
        if even_bit:
            midpoint = (lon_range[0] + lon_range[1]) / 2
            if longitude >= midpoint:
                accumulator |= _BITS[bit]
                lon_range[0] = midpoint
            else:
                lon_range[1] = midpoint
        else:
            midpoint = (lat_range[0] + lat_range[1]) / 2
            if latitude >= midpoint:
                accumulator |= _BITS[bit]
                lat_range[0] = midpoint
            else:
                lat_range[1] = midpoint

        even_bit = not even_bit

        if bit < 4:
            bit += 1
        else:
            characters.append(BASE32[accumulator])
            bit = 0
            accumulator = 0

    return "".join(characters)


def parse_coordinate(value: str | float | None) -> float | None:
    """Parse a coordinate that arrives as text, returning ``None`` for blanks.

    Coordinates come out of the CSV as strings. They are read as strings on purpose —
    the same reason parcel ids are — so the cast is explicit and its failure mode is a
    null rather than a Spark-wide schema inference pass over 121 MB.
    """
    if value is None:
        return None
    if isinstance(value, float | int):
        return float(value)
    text = value.strip()
    if not text:
        return None
    try:
        return float(text)
    except ValueError:
        return None
