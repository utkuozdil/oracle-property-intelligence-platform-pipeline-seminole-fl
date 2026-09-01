"""Pure derivation logic for the Seminole parcel snapshot.

Every function here is a total function over primitive values: no Spark, no boto3, no
clock, no network. That is deliberate. The transform's real risk is not distributed
computation, it is arithmetic on a source with 38,308 leading-zero parcel ids, an
``Improved``/``Vacant`` flag that gates every year field, and a mailing address parsed
out of one free-text column. All of that is decided here and asserted in ``tests/``,
and the Glue job's only job is to map these over columns.

The Glue job wraps each of these in a ``pyspark.sql.functions.udf``; keeping them out of
the job module is what lets ``uv run pytest`` cover them with no Spark on the machine.
"""

from __future__ import annotations

import re
from typing import Final

#: The county's own binary. Measured on the extract: 161,981 ``Improved`` / 19,236
#: ``Vacant`` and nothing else — no blanks, no variant spellings, no title-case drift.
IMPROVED: Final = "Improved"
VACANT: Final = "Vacant"

#: Oldest plausible construction year in the county. Anything earlier is a data entry
#: artefact (typically a transposed digit) rather than a genuinely antebellum structure.
MIN_PLAUSIBLE_YEAR: Final = 1800

#: Tax-district codes that are unincorporated county rather than a municipality.
#: `G1` is the agricultural district, which is likewise not a city.
UNINCORPORATED_CODES: Final[frozenset[str]] = frozenset({"01", "02", "G1"})

#: Tax-district code prefix -> municipality. Seminole issues one code per city plus
#: suffixed variants for CDDs and redevelopment districts (`V1`, `V2`, `V5` are all
#: Oviedo), so the jurisdiction is keyed off the leading letter, not the whole code.
MUNICIPALITY_BY_CODE_PREFIX: Final[dict[str, str]] = {
    "S": "Sanford",
    "A": "Altamonte Springs",
    "W": "Winter Springs",
    "V": "Oviedo",
    "C": "Casselberry",
    "M": "Lake Mary",
    "L": "Longwood",
}

UNINCORPORATED: Final = "Unincorporated Seminole County"

#: ZIP5s that lie wholly or partly inside Seminole County. An owner whose mailing
#: address is outside this set is treated as out-of-area. Sourced from the USPS ZIP
#: assignments for the county's municipalities and unincorporated areas.
SEMINOLE_ZIP5: Final[frozenset[str]] = frozenset(
    {
        "32701",  # Altamonte Springs
        "32703",  # Apopka (Seminole portion)
        "32707",  # Casselberry
        "32708",  # Winter Springs
        "32714",  # Altamonte Springs
        "32715",  # Altamonte Springs (PO boxes)
        "32716",  # Altamonte Springs (PO boxes)
        "32718",  # Longwood (PO boxes)
        "32719",  # Longwood (PO boxes)
        "32730",  # Fern Park
        "32732",  # Geneva
        "32733",  # Goldenrod
        "32745",  # Lake Monroe
        "32746",  # Lake Mary
        "32747",  # Lake Mary (PO boxes)
        "32750",  # Longwood
        "32752",  # Longwood (PO boxes)
        "32762",  # Oviedo (PO boxes)
        "32765",  # Oviedo
        "32766",  # Oviedo
        "32771",  # Sanford
        "32772",  # Sanford (PO boxes)
        "32773",  # Sanford
        "32779",  # Longwood / Wekiva Springs
        "32791",  # Longwood (PO boxes)
        "32792",  # Winter Park (Seminole portion)
        "32795",  # Winter Park (PO boxes)
        "32799",  # Mid-Florida
    }
)

#: `CITY, ST ZIP5[-ZIP4]`. Parses 178,414 of the 178,924 mailing labels; the 0.28%
#: remainder are foreign addresses with no US state, and resolve to "unknown".
_CITY_STATE_ZIP = re.compile(
    r"^(?P<city>.+?)[\s,]+(?P<state>[A-Za-z]{2})[\s,]+(?P<zip5>\d{5})(?:-\d{4})?\s*$"
)

_NON_ALNUM = re.compile(r"[^A-Z0-9]+")

#: Renovation bands, in years of effective-age uplift over original construction.
RENOVATION_NONE: Final = "none"
RENOVATION_MODERATE: Final = "moderate"
RENOVATION_MAJOR: Final = "major"
_MAJOR_RENOVATION_YEARS: Final = 10


def parcel_id_text(value: str | None) -> str | None:
    """Return a parcel id as text, preserving leading zeros.

    Seminole parcel ids are 17-character strings and 38,308 of them start with ``0``.
    They are never numbers: ``01202930000100000`` read as an integer becomes
    ``1202930000100000`` and stops matching every other table.
    """
    if value is None:
        return None
    stripped = value.strip()
    return stripped or None


def is_improved(vacant_improved: str | None) -> bool:
    """True when the parcel carries a structure."""
    return (vacant_improved or "").strip() == IMPROVED


def parse_year(value: str | int | None, *, snapshot_year: int) -> int | None:
    """Parse a four-digit year, returning ``None`` for blanks and implausible values.

    Guards both ends: a year before :data:`MIN_PLAUSIBLE_YEAR` or after the snapshot year
    is a keying error, and letting either through produces negative or absurd ages that
    are worse than a null.
    """
    if value is None:
        return None
    if isinstance(value, int):
        year = value
    else:
        text = value.strip()
        if not text:
            return None
        try:
            year = int(float(text)) if "." in text else int(text)
        except ValueError:
            return None
    if not MIN_PLAUSIBLE_YEAR <= year <= snapshot_year:
        return None
    return year


def effective_roof_year(
    year_built: str | int | None,
    year_last_bldg_built: str | int | None,
    max_effective_year_blt: str | int | None,
    *,
    snapshot_year: int,
) -> int | None:
    """Best available proxy for when the roof last reached "as new".

    All three inputs have identical coverage on the extract (161,980 rows, exactly the
    improved set), so this is a quality preference rather than a completeness fallback:

    1. ``MaxEffectiveYearBlt`` — the appraiser's own renovation-adjusted age, which is
       the only field that moves when a roof is replaced without a permit-triggered
       rebuild.
    2. ``YearLastBldgBuilt`` — the newest structure on a multi-building parcel.
    3. ``YearBuilt`` — original construction.

    Returns the **maximum** of whichever are present rather than the first, because a
    parcel whose original ``YearBuilt`` post-dates a stale effective year should not be
    aged off the older number.
    """
    candidates = [
        parse_year(max_effective_year_blt, snapshot_year=snapshot_year),
        parse_year(year_last_bldg_built, snapshot_year=snapshot_year),
        parse_year(year_built, snapshot_year=snapshot_year),
    ]
    present = [year for year in candidates if year is not None]
    return max(present) if present else None


def roof_age(
    vacant_improved: str | None,
    year_built: str | int | None,
    year_last_bldg_built: str | int | None,
    max_effective_year_blt: str | int | None,
    *,
    snapshot_year: int,
) -> int | None:
    """Years since the roof last reached "as new", or ``None`` when unknowable.

    **This is not the age of the building.** It is driven by
    ``MaxEffectiveYearBlt`` — the appraiser's renovation-adjusted year — and not by
    ``YearBuilt``. On this extract that makes ``roof_age`` top out at 126 years while the
    oldest ``year_built`` is 1872, a gap of several decades on the county's old housing
    stock.

    That is deliberate and correct for the intended use: a reroof resets the roof's
    condition without touching the year the house was built, and it is the effective year
    that moves when it happens. But it means the two columns answer different questions,
    and anyone comparing ``roof_age`` against ``year_built`` will find they disagree by
    decades on exactly the properties where roof condition matters most. Use
    ``snapshot_year - year_built`` if structural age is what is wanted.

    ``None`` for vacant land by definition — there is no roof — which is why the flag is
    checked before the year fields rather than relying on their emptiness. On this extract
    that leaves ``roof_age`` null for 19,239 of 181,218 parcels; those nulls are the
    vacant set and must stay null rather than being read as an age of zero.
    """
    if not is_improved(vacant_improved):
        return None
    effective = effective_roof_year(
        year_built,
        year_last_bldg_built,
        max_effective_year_blt,
        snapshot_year=snapshot_year,
    )
    if effective is None:
        return None
    return snapshot_year - effective


def years_since_sale(
    last_sale_date: str | None,
    last_sale_year: str | int | None,
    *,
    snapshot_year: int,
) -> int | None:
    """Years since the most recent recorded sale.

    Prefers the year embedded in ``LastSaleDate`` and falls back to ``LastSaleYear``.
    Never-sold parcels — new plats and government holdings — return ``None`` rather
    than an arbitrarily large number that would pollute any downstream percentile.
    """
    from_date = _year_from_date(last_sale_date)
    year = parse_year(from_date, snapshot_year=snapshot_year) or parse_year(
        last_sale_year, snapshot_year=snapshot_year
    )
    if year is None:
        return None
    return snapshot_year - year


def _year_from_date(value: str | None) -> int | None:
    """Pull a four-digit year out of a date string in any of the source's formats."""
    if not value:
        return None
    match = re.search(r"(?:^|[^0-9])((?:1[89]|20)\d{2})(?:[^0-9]|$)", value.strip())
    return int(match.group(1)) if match else None


def renovation_signal(
    vacant_improved: str | None,
    year_built: str | int | None,
    max_effective_year_blt: str | int | None,
    *,
    snapshot_year: int,
) -> str | None:
    """How much the appraiser's effective age has been lifted above original build.

    ``MaxEffectiveYearBlt - YearBuilt`` is the county's own record of substantial
    improvement. Banding it keeps the signal usable without pretending the underlying
    number is precise:

    - ``none``     — no uplift recorded
    - ``moderate`` — 1 to 9 years of uplift
    - ``major``    — 10 or more years of uplift

    ``None`` for vacant land and for parcels missing either year.
    """
    if not is_improved(vacant_improved):
        return None
    original = parse_year(year_built, snapshot_year=snapshot_year)
    effective = parse_year(max_effective_year_blt, snapshot_year=snapshot_year)
    if original is None or effective is None:
        return None
    uplift = effective - original
    if uplift <= 0:
        return RENOVATION_NONE
    if uplift < _MAJOR_RENOVATION_YEARS:
        return RENOVATION_MODERATE
    return RENOVATION_MAJOR


def tax_district_code(tax_district: str | None) -> str | None:
    """Extract the code from a ``"S1 - SANFORD"``-style tax district value.

    ``Parcels.csv`` packs the code and description into one column while ``Taxes.csv``
    splits them, so both shapes have to reduce to the same code.
    """
    if not tax_district:
        return None
    code = tax_district.split("-", 1)[0].strip().upper()
    return code or None


def jurisdiction(tax_district: str | None) -> str:
    """Municipality that governs the parcel, or unincorporated county.

    Derived from the tax district because Seminole's own ``PrimaryAddress`` city is a
    postal city, and postal cities cross municipal boundaries — a "Longwood, FL" address
    is frequently unincorporated county. The tax district is the legal answer.
    """
    code = tax_district_code(tax_district)
    if code is None:
        return UNINCORPORATED
    if code in UNINCORPORATED_CODES:
        return UNINCORPORATED
    return MUNICIPALITY_BY_CODE_PREFIX.get(code[0], UNINCORPORATED)


def parse_city_state_zip(value: str | None) -> tuple[str | None, str | None, str | None]:
    """Split a ``CityStateZip`` label into ``(city, state, zip5)``.

    ``MailingLabels.csv`` carries the whole tail of the address in one free-text column
    (``"LONGWOOD, FL 32779-5041"``). Returns all-``None`` when the value does not parse,
    which on the extract is 510 of 178,924 rows — foreign addresses with no US state.
    """
    if not value:
        return (None, None, None)
    match = _CITY_STATE_ZIP.match(value.strip())
    if match is None:
        return (None, None, None)
    return (
        match.group("city").strip().rstrip(",").upper() or None,
        match.group("state").upper(),
        match.group("zip5"),
    )


def owner_out_of_area(city_state_zip: str | None) -> bool | None:
    """True when the owner's mail goes somewhere outside Seminole County.

    An absentee-owner proxy: out-of-state mail, or in-state mail to a ZIP outside the
    county. Returns ``None`` — not ``False`` — when the address does not parse, so an
    unparseable label is never counted as a local owner.
    """
    _city, state, zip5 = parse_city_state_zip(city_state_zip)
    if state is None or zip5 is None:
        return None
    if state != "FL":
        return True
    return zip5 not in SEMINOLE_ZIP5


def normalize_subdivision_name(value: str | None) -> str | None:
    """Uppercase and strip punctuation from a subdivision name for joining.

    ``Subdivision.csv`` does **not** join to the parcel spine on ``Parcel`` — only 3 of
    its 4,002 rows carry a parcel id that exists in ``Parcels.csv``. It joins on the
    name, and the two sides disagree on case and punctuation (``"125 & 131 Condominium"``
    versus ``"125 131 CONDOMINIUM"``). Normalising both sides lifts the match from 0 to
    3,894 of 4,047 distinct names.
    """
    if not value:
        return None
    normalized = _NON_ALNUM.sub(" ", value.upper()).strip()
    return normalized or None
